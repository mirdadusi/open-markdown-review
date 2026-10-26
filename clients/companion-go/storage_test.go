package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathModeRejectsLinksAndWindowsJunctions(t *testing.T) {
	for _, mode := range []os.FileMode{os.ModeSymlink, os.ModeSymlink | os.ModeDir, os.ModeIrregular} {
		for _, ancestor := range []bool{false, true} {
			if err := checkedPathMode(mode, ancestor); err == nil || !strings.Contains(err.Error(), "links/junctions") {
				t.Fatalf("mode %v ancestor=%v did not explicitly reject links/junctions: %v", mode, ancestor, err)
			}
		}
	}
	for _, mode := range []os.FileMode{os.ModeDir, os.ModeDir | os.ModeIrregular} {
		if err := checkedPathMode(mode, true); err != nil {
			t.Fatalf("rejected a non-name-surrogate directory %v: %v", mode, err)
		}
	}
	if err := checkedPathMode(0600, false); err != nil {
		t.Fatal("rejected a regular file", err)
	}
	if err := checkedPathMode(0600, true); err == nil || err.Error() != "not a directory" {
		t.Fatal("accepted a regular file as a parent directory", err)
	}
}

func testRoot(t *testing.T) (*os.Root, string) {
	t.Helper()
	directory := t.TempDir()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return root, directory
}
func TestConfinedStorage(t *testing.T) {
	r, _ := testRoot(t)
	for _, name := range []string{"", "../outside", "/outside", "C:/outside", "a//b", "a/./b", "a/../b", "a\\b", "a\x00b"} {
		if checkedPath(r, name, true) == nil {
			t.Fatalf("accepted unsafe path %q", name)
		}
	}
	bytes := []byte("frozen evidence")
	if err := writeEvidence(r, "blobs/aa/item", bytes, false); err != nil {
		t.Fatal(err)
	}
	actual, err := boundedRead(r, "blobs/aa/item", int64(len(bytes)))
	if err != nil || string(actual) != string(bytes) {
		t.Fatal("read differs", err)
	}
	if _, err = boundedRead(r, "blobs/aa/item", 1); err == nil {
		t.Fatal("read limit ignored")
	}
	if err = writeEvidence(r, "blobs/aa/item", bytes, false); err != nil {
		t.Fatal("idempotent write failed", err)
	}
	if err = writeEvidence(r, "blobs/aa/item", []byte("changed"), false); err == nil {
		t.Fatal("overwrote existing evidence")
	}
}
func TestExactPrefixRecovery(t *testing.T) {
	r, _ := testRoot(t)
	full := []byte("publication with exact intent")
	if err := writeEvidence(r, "item", full[:8], false); err != nil {
		t.Fatal(err)
	}
	if err := writeEvidence(r, "item", full, true); err != nil {
		t.Fatal(err)
	}
	actual, err := boundedRead(r, "item", int64(len(full)))
	if err != nil || !bytes.Equal(actual, full) {
		t.Fatal("recovery differs", err)
	}
	if err = writeEvidence(r, "item", []byte("different intent"), true); err == nil {
		t.Fatal("accepted changed recovery intent")
	}
}

func TestBoundedReadExactSizesAndEmptyFiles(t *testing.T) {
	r, _ := testRoot(t)
	for _, length := range []int{0, 1, 511, 512, 513, 65536, 1048576} {
		name := filepath.ToSlash(filepath.Join("sizes", fmt.Sprint(length)))
		payload := bytes.Repeat([]byte{173}, length)
		if err := writeEvidence(r, name, payload, false); err != nil {
			t.Fatal(err)
		}
		for _, limit := range []int64{int64(length) + 1, int64(length) + 1024} {
			actual, err := boundedRead(r, name, limit)
			if err != nil || !bytes.Equal(actual, payload) {
				t.Fatalf("bounded read %d/%d: %v", length, limit, err)
			}
		}
		if length > 1 {
			if _, err := boundedRead(r, name, int64(length-1)); err == nil {
				t.Fatal("accepted excessive file")
			}
		}
	}
}
func TestStorageRootCannotEscape(t *testing.T) {
	r, dir := testRoot(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		// Windows CI may lack the unprivileged symlink capability; the shared
		// security suite separately creates and checks a native junction there.
		t.Log("OS disallows test symlink:", err)
		return
	}
	if _, err := boundedRead(r, "link/secret", 100); err == nil {
		t.Fatal("read linked evidence")
	}
	if err := writeEvidence(r, "link/added", []byte("bad"), false); err == nil {
		t.Fatal("wrote through linked ancestor")
	}
}
