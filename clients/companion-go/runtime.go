package main

import (
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/dop251/goja"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

//go:embed assets/core.js assets/toolbox.html assets/provenance.json assets/LICENSE assets/THIRD-PARTY-NOTICES.txt assets/go-dependencies.json
var assets embed.FS

const maxBody int64 = ((268435456+2)/3)*4 + 131072

type runtimeHost struct {
	vm           *goja.Runtime
	mu           sync.Mutex
	root         *os.Root
	rootPath     string
	initial      os.FileInfo
	manifestHash [32]byte
	journals     map[string]*os.Root
	stop         chan struct{}
	stopOnce     sync.Once
	fault        string
	jobs         chan func() error
	timers       map[int]*time.Timer
	nextTimer    int
}

func bytesArg(v goja.Value) []byte {
	if b, ok := v.Export().([]byte); ok {
		return b
	}
	panic("expected typed bytes")
}

func nativeSHA256(vm *goja.Runtime, value goja.Value) goja.ArrayBuffer {
	result := sha256.Sum256(bytesArg(value))
	return vm.NewArrayBuffer(result[:])
}

type nativeError struct {
	code    string
	message string
}

func (e nativeError) Error() string { return e.message }
func nativeCode(err error) string {
	var protocol nativeError
	if errors.As(err, &protocol) {
		return protocol.code
	}
	if errors.Is(err, os.ErrNotExist) {
		return "missing"
	}
	if errors.Is(err, os.ErrPermission) {
		return "permission"
	}
	if strings.Contains(err.Error(), "links") || strings.Contains(err.Error(), "replaced") || strings.Contains(err.Error(), "manifest changed") {
		return "integrity"
	}
	return "uncertain"
}
func (h *runtimeHost) throwIO(err error) {
	if err == nil {
		return
	}
	e := h.vm.NewGoError(err)
	_ = e.Set("code", nativeCode(err))
	panic(e)
}
func (h *runtimeHost) initialize() (string, error) {
	h.vm = goja.New()
	h.installTimers()
	h.vm.Set("__root", h.rootPath)
	h.vm.Set("__encode", func(s string) goja.ArrayBuffer { return h.vm.NewArrayBuffer([]byte(s)) })
	h.vm.Set("__decode", func(v goja.Value) string {
		b := bytesArg(v)
		if !utf8.Valid(b) {
			panic(h.vm.NewTypeError("invalid UTF-8"))
		}
		return string(b)
	})
	h.vm.Set("__b64", func(v goja.Value) string { return base64.StdEncoding.EncodeToString(bytesArg(v)) })
	h.vm.Set("__unb64", func(s string) goja.ArrayBuffer {
		b, err := base64.StdEncoding.Strict().DecodeString(s)
		if err != nil {
			panic(h.vm.NewTypeError("invalid base64"))
		}
		return h.vm.NewArrayBuffer(b)
	})
	h.vm.Set("__sha256", func(v goja.Value) goja.ArrayBuffer {
		return nativeSHA256(h.vm, v)
	})
	// Native bytes cross the VM as an ArrayBuffer, never a reflected Go slice.
	// No intermediate JSON/base64 on the storage boundary.
	h.vm.Set("__read", func(file string, limit int64) goja.ArrayBuffer {
		if limit < 1 || limit > maxBody {
			h.throwIO(errors.New("invalid read limit"))
		}
		b, err := boundedRead(h.root, file, limit)
		h.throwIO(err)
		return h.vm.NewArrayBuffer(b)
	})
	h.vm.Set("__write", func(file string, value goja.Value, recover bool) {
		b := bytesArg(value)
		if testFaults && h.fault != "" {
			fault, err := os.ReadFile(h.fault)
			if err == nil && string(fault) == file {
				h.throwIO(os.Rename(h.fault, h.fault+".consumed"))
				h.throwIO(writeEvidence(h.root, file, b[:min(8, len(b))], false))
				h.throwIO(errors.New("injected interrupted native publication"))
			}
		}
		h.throwIO(writeEvidence(h.root, file, b, recover))
	})
	h.vm.Set("__random", func() string {
		n := nonce()
		return n[:8] + "-" + n[8:12] + "-4" + n[13:16] + "-8" + n[17:20] + "-" + n[20:32]
	})
	h.vm.Set("__stop", func() { h.stopOnce.Do(func() { time.AfterFunc(50*time.Millisecond, func() { close(h.stop) }) }) })
	h.vm.Set("__io", func(scope, method, raw string) string {
		var args []json.RawMessage
		err := json.Unmarshal([]byte(raw), &args)
		var value any
		if err == nil {
			value, err = h.operation(scope, method, args)
		}
		result := map[string]any{"ok": err == nil, "value": value}
		if err != nil {
			result["code"] = nativeCode(err)
			result["error"] = err.Error()
		}
		b, _ := json.Marshal(result)
		return string(b)
	})
	if _, err := h.vm.RunString(`globalThis.TextEncoder=class{encode(s){return new Uint8Array(__encode(s))}};globalThis.TextDecoder=class{decode(b){return __decode(b)}};`); err != nil {
		return "", err
	}
	script, _ := assets.ReadFile("assets/core.js")
	if _, err := h.vm.RunString(string(script)); err != nil {
		return "", err
	}
	value, err := h.call("initialize")
	if err != nil {
		return "", err
	}
	return value.String(), nil
}

func validateEmbeddedAssets() error {
	b, err := assets.ReadFile("assets/provenance.json")
	if err != nil {
		return err
	}
	var p struct {
		SchemaVersion string            `json:"schemaVersion"`
		Complete      bool              `json:"complete"`
		Inputs        map[string]string `json:"inputs"`
	}
	if err = json.Unmarshal(b, &p); err != nil || !p.Complete || p.SchemaVersion != "omr-go-build/1" {
		return errors.New("incomplete companion build; rebuild with the supported build script")
	}
	for key, file := range map[string]string{"core": "core.js", "toolbox": "toolbox.html", "notices": "THIRD-PARTY-NOTICES.txt"} {
		bytes, err := assets.ReadFile("assets/" + file)
		if err != nil {
			return err
		}
		if "sha256:"+sum(bytes) != p.Inputs[key] {
			return errors.New("embedded companion assets differ from build provenance")
		}
	}
	return nil
}
func (h *runtimeHost) call(name string, args ...goja.Value) (goja.Value, error) {
	obj := h.vm.Get("OMR").ToObject(h.vm)
	fn, ok := goja.AssertFunction(obj.Get(name))
	if !ok {
		return nil, errors.New("missing embedded function")
	}
	v, err := fn(goja.Undefined(), args...)
	if err != nil {
		return nil, err
	}
	if p, ok := v.Export().(*goja.Promise); ok {
		// Shared file-stability retries genuinely wait; do not replace timers with
		// immediate callbacks or call a Goja VM concurrently from a timer goroutine.
		deadline := time.NewTimer(120 * time.Second)
		defer deadline.Stop()
		for p.State() == goja.PromiseStatePending {
			select {
			case job := <-h.jobs:
				if err := job(); err != nil {
					return nil, err
				}
			case <-deadline.C:
				return nil, errors.New("shared core async operation timed out")
			case <-h.stop:
				return nil, errors.New("companion is stopping")
			}
		}
		if p.State() == goja.PromiseStateRejected {
			return nil, fmt.Errorf("shared core rejected: %s", p.Result())
		}
		if p.State() != goja.PromiseStateFulfilled {
			return nil, errors.New("shared core has a pending promise")
		}
		v = p.Result()
	}
	return v, nil
}

func (h *runtimeHost) installTimers() {
	h.jobs = make(chan func() error, 128)
	h.timers = map[int]*time.Timer{}
	h.vm.Set("setTimeout", func(call goja.FunctionCall) goja.Value {
		fn, ok := goja.AssertFunction(call.Argument(0))
		if !ok {
			panic(h.vm.NewTypeError("expected timer callback"))
		}
		delay := call.Argument(1).ToInteger()
		if delay < 0 {
			delay = 0
		}
		if delay > 86400000 {
			delay = 86400000
		}
		if len(h.timers) >= 128 {
			panic(h.vm.NewTypeError("timer admission limit exceeded"))
		}
		h.nextTimer++
		id := h.nextTimer
		h.timers[id] = time.AfterFunc(time.Duration(delay)*time.Millisecond, func() {
			select {
			case h.jobs <- func() error {
				if _, exists := h.timers[id]; !exists {
					return nil
				}
				delete(h.timers, id)
				_, err := fn(goja.Undefined())
				return err
			}:
			case <-h.stop:
			}
		})
		return h.vm.ToValue(id)
	})
	h.vm.Set("clearTimeout", func(id int) {
		if timer := h.timers[id]; timer != nil {
			timer.Stop()
			delete(h.timers, id)
		}
	})
}
