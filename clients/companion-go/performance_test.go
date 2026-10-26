package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dop251/goja"
)

var performanceBytes []byte
var performanceString string
var performanceEventIndex int

// The driver authors a disposable review through the real shared authoring core.
// No reduced validator, second protocol fixture writer or production debug API.
func performanceHost(b *testing.B) (*runtimeHost, string, []byte) {
	b.Helper()
	rootPath, file := os.Getenv("OMR_GO_PERF_REVIEW"), os.Getenv("OMR_GO_PERF_BLOB")
	if rootPath == "" || file == "" {
		b.Skip("Run scripts/profile-go-companion.mjs with a real disposable review")
	}
	rootPath, err := filepath.EvalSymlinks(rootPath)
	if err != nil {
		b.Fatal(err)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = root.Close() })
	initial, err := os.Lstat(rootPath)
	if err != nil {
		b.Fatal(err)
	}
	h := &runtimeHost{root: root, rootPath: rootPath, initial: initial, journals: map[string]*os.Root{}, stop: make(chan struct{})}
	manifest, err := boundedRead(root, "manifest.json", 1<<20)
	if err != nil {
		b.Fatal(err)
	}
	h.manifestHash = sha256.Sum256(manifest)
	for _, scope := range []string{"client", "host"} {
		journal, err := os.OpenRoot(b.TempDir())
		if err != nil {
			b.Fatal(err)
		}
		b.Cleanup(func() { _ = journal.Close() })
		h.journals[scope] = journal
	}
	if _, err := h.initialize(); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		for _, timer := range h.timers {
			timer.Stop()
		}
	})
	payload, err := boundedRead(root, file, 8<<20)
	if err != nil {
		b.Fatal(err)
	}
	return h, file, payload
}

func BenchmarkCompanionStages(b *testing.B) {
	for _, stage := range []string{"rooted-read", "native-base64", "native-response-json", "vm-response-json", "vm-typed-array", "vm-journal-array-copy", "vm-journal-binary-copy", "shared-digest", "shared-request-parser", "full-read-rpc", "validated-comment"} {
		b.Run(stage, func(b *testing.B) {
			h, file, payload := performanceHost(b)
			encoded := base64.StdEncoding.EncodeToString(payload)
			_ = h.vm.Set("__perfBytes", h.vm.NewArrayBuffer(payload))
			_ = h.vm.Set("__perfBase64", encoded)
			var work func()
			switch stage {
			case "validated-comment":
				vectors, err := os.ReadFile(os.Getenv("OMR_GO_PERF_EVENTS"))
				if err != nil {
					b.Fatal(err)
				}
				var requests []string
				if err := json.Unmarshal(vectors, &requests); err != nil {
					b.Fatal(err)
				}
				work = func() {
					if performanceEventIndex >= len(requests) {
						b.Fatal("profiling event vectors exhausted")
					}
					request := requests[performanceEventIndex]
					performanceEventIndex++
					value, err := h.call("request", h.vm.ToValue(request))
					if err != nil {
						b.Fatal(err)
					}
					result, ok := value.Export().(map[string]any)
					if !ok || result["ok"] != true {
						b.Fatalf("comment rejected: %v", value)
					}
				}
			case "rooted-read":
				work = func() {
					var err error
					performanceBytes, err = boundedRead(h.root, file, int64(len(payload)))
					if err != nil {
						b.Fatal(err)
					}
				}
			case "native-base64":
				work = func() { performanceString = base64.StdEncoding.EncodeToString(payload) }
			case "native-response-json":
				work = func() {
					var err error
					performanceBytes, err = json.Marshal(map[string]any{"ok": true, "value": encoded})
					if err != nil {
						b.Fatal(err)
					}
				}
			default:
				var function goja.Callable
				var args []goja.Value
				switch stage {
				case "vm-response-json":
					v, err := h.vm.RunString(`(function(){return JSON.stringify({ok:true,value:__perfBase64})})`)
					if err != nil {
						b.Fatal(err)
					}
					function, _ = goja.AssertFunction(v)
				case "vm-typed-array":
					v, err := h.vm.RunString(`(function(){return new Uint8Array(__perfBytes).byteLength})`)
					if err != nil {
						b.Fatal(err)
					}
					function, _ = goja.AssertFunction(v)
				case "vm-journal-array-copy":
					v, err := h.vm.RunString(`(function(){return new Uint8Array(Array.from(new Uint8Array(__perfBytes))).byteLength})`)
					if err != nil {
						b.Fatal(err)
					}
					function, _ = goja.AssertFunction(v)
				case "vm-journal-binary-copy":
					v, err := h.vm.RunString(`(function(){return new Uint8Array(new Uint8Array(__perfBytes).slice()).byteLength})`)
					if err != nil {
						b.Fatal(err)
					}
					function, _ = goja.AssertFunction(v)
				case "shared-digest", "shared-request-parser":
					bundle, err := os.ReadFile(os.Getenv("OMR_GO_PERF_PRIMITIVES"))
					if err != nil {
						b.Fatal(err)
					}
					if _, err = h.vm.RunString(string(bundle)); err != nil {
						b.Fatal(err)
					}
					name := "digest"
					argument := `new Uint8Array(__perfBytes)`
					if stage == "shared-request-parser" {
						name = "parseCompanionRequest"
						body, _ := json.Marshal(map[string]any{"method": "write", "args": []any{file, encoded, false}})
						_ = h.vm.Set("__perfRequest", string(body))
						argument = `new TextEncoder().encode(__perfRequest)`
					}
					v, err := h.vm.RunString(`(function(){return PERF.` + name + `(` + argument + `)})`)
					if err != nil {
						b.Fatal(err)
					}
					function, _ = goja.AssertFunction(v)
				case "full-read-rpc":
					request, _ := json.Marshal(map[string]any{"method": "read", "args": []any{file, len(payload)}})
					args = []goja.Value{h.vm.ToValue(string(request))}
				}
				work = func() {
					var value goja.Value
					var err error
					if stage == "full-read-rpc" {
						value, err = h.call("request", args...)
					} else {
						value, err = function(goja.Undefined())
					}
					if err != nil {
						b.Fatal(err)
					}
					if stage == "full-read-rpc" {
						if original, ok := value.Export().(string); ok {
							performanceString = original
						} else {
							performanceBytes, err = json.Marshal(value.Export())
							if err != nil {
								b.Fatal(err)
							}
						}
					} else {
						performanceString = value.String()
					}
				}
			}
			if stage == "validated-comment" {
				b.SetBytes(8192)
			} else if stage != "vm-typed-array" {
				b.SetBytes(int64(len(payload)))
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				work()
			}
		})
	}
}
