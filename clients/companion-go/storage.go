package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

func sum(b []byte) string { v := sha256.Sum256(b); return hex.EncodeToString(v[:]) }
func checkedPathMode(mode os.FileMode, ancestor bool) error {
	// Modern Go reports Windows mount-point junctions as ModeIrregular without
	// ModeDir, not ModeSymlink. Reject them explicitly before directory checks.
	// An irregular directory is not necessarily a name-surrogate reparse point.
	if mode&os.ModeSymlink != 0 || mode&os.ModeIrregular != 0 && !mode.IsDir() {
		return errors.New("symbolic links/junctions or irregular files are not allowed")
	}
	if ancestor && !mode.IsDir() {
		return errors.New("not a directory")
	}
	return nil
}
func checkedPath(root *os.Root, name string, parents bool) error {
	if name == "" || filepath.IsAbs(name) || strings.ContainsAny(name, "\\:\x00") {
		return errors.New("unsafe protocol path")
	}
	parts := strings.Split(name, "/")
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			return errors.New("unsafe protocol path")
		}
		current := strings.Join(parts[:i+1], "/")
		info, err := root.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if i < len(parts)-1 && parents {
				if err = root.Mkdir(current, 0700); err != nil && !errors.Is(err, os.ErrExist) {
					return err
				}
				info, err = root.Lstat(current)
			} else if i == len(parts)-1 {
				return nil
			}
		}
		if err != nil {
			return err
		}
		if err := checkedPathMode(info.Mode(), i < len(parts)-1); err != nil {
			return err
		}
	}
	return nil
}
func boundedRead(root *os.Root, name string, limit int64) ([]byte, error) {
	if err := checkedPath(root, name, false); err != nil {
		return nil, err
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, errors.New("file exceeds read limit or is not regular")
	}
	// Size is already bounded. Allocate once instead of ReadAll's repeated
	// growth/copy cycle. The extra byte detects growth; short reads and the
	// before/after metadata and containment checks still fail closed.
	b := make([]byte, before.Size()+1)
	n, err := io.ReadFull(f, b)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	b = b[:n]
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != before.Size() || int64(len(b)) > limit || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return nil, errors.New("file changed during read")
	}
	if err := checkedPath(root, name, false); err != nil {
		return nil, err
	}
	return b, nil
}
func writeEvidence(root *os.Root, name string, b []byte, recover bool) error {
	if err := checkedPath(root, name, true); err != nil {
		return err
	}
	flags := os.O_CREATE | os.O_WRONLY | os.O_EXCL
	if recover {
		flags = os.O_CREATE | os.O_RDWR
	}
	f, err := root.OpenFile(name, flags, 0600)
	if errors.Is(err, os.ErrExist) {
		old, e := boundedRead(root, name, int64(len(b)))
		if e == nil && bytes.Equal(old, b) {
			return nil
		}
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if err = checkedPath(root, name, false); err != nil {
		return err
	}
	if recover {
		old, e := io.ReadAll(io.LimitReader(f, int64(len(b))+1))
		if e != nil {
			return e
		}
		if bytes.Equal(old, b) {
			return nil
		}
		if len(old) >= len(b) || !bytes.HasPrefix(b, old) {
			return errors.New("pending file changed before recovery")
		}
		if _, e = f.Seek(0, 0); e != nil {
			return e
		}
	}
	if _, err = f.Write(b); err != nil {
		return err
	}
	if err = f.Truncate(int64(len(b))); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	return checkedPath(root, name, false)
}
func (h *runtimeHost) binding() error {
	now, err := os.Lstat(h.rootPath)
	if err != nil {
		return err
	}
	if !os.SameFile(h.initial, now) || now.Mode()&os.ModeSymlink != 0 {
		return errors.New("selected review was replaced")
	}
	data, err := boundedRead(h.root, "manifest.json", 1048576)
	if err != nil {
		return err
	}
	if sha256.Sum256(data) != h.manifestHash {
		return errors.New("immutable review manifest changed")
	}
	return nil
}
func (h *runtimeHost) operation(scope, method string, args []json.RawMessage) (any, error) {
	var file string
	if len(args) > 0 {
		_ = json.Unmarshal(args[0], &file)
	}
	switch method {
	case "binding":
		return nil, h.binding()
	case "list":
		if err := checkedPath(h.root, file, false); err != nil {
			return nil, err
		}
		directory, err := h.root.Open(file)
		if err != nil {
			return nil, err
		}
		defer directory.Close()
		entries, err := directory.ReadDir(-1)
		if err != nil {
			return nil, err
		}
		names := []string{}
		for _, entry := range entries {
			if err := checkedPathMode(entry.Type(), false); err != nil {
				return nil, err
			}
			if entry.Type().IsRegular() {
				names = append(names, entry.Name())
			}
		}
		return names, nil
	case "journalGet":
		r := h.journals[scope]
		if r == nil {
			return nil, errors.New("invalid private scope")
		}
		b, err := boundedRead(r, sum([]byte(h.rootPath+"\x00"+file))+".json", maxBody*8)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if !utf8.Valid(b) {
			return nil, nativeError{code: "invalid", message: "Expected UTF-8 in the private journal."}
		}
		// Preserve the original JSON source. The shared strict parser must see
		// duplicate keys/surrogate escapes before Go's decoder normalizes them.
		return string(b), nil
	case "journalPut":
		r := h.journals[scope]
		if r == nil || len(args) != 2 {
			return nil, errors.New("invalid private scope")
		}
		name := sum([]byte(h.rootPath+"\x00"+file)) + ".json"
		temporary := name + "." + nonce()
		if err := writeEvidence(r, temporary, args[1], false); err != nil {
			return nil, err
		}
		if err := checkedPath(r, name, false); err != nil {
			return nil, err
		}
		return nil, r.Rename(temporary, name)
	}
	return nil, errors.New("unsupported native IO operation")
}
