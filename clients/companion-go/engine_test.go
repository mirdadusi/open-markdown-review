package main

import (
	"github.com/dop251/goja"
	"strings"
	"testing"
	"time"
)

func TestEngineFeatures(t *testing.T) {
	for _, probe := range []struct{ name, source string }{
		{"async", `(async function(){return await Promise.resolve(7)})()`},
		{"typed-arrays", `Array.from(new Uint8Array([1,2,3])).join(',')`},
		{"regexp-lookbehind", `/(?<!a)b/u.test('cb')`},
		{"class-fields", `class A{x=7};new A().x`},
		{"bigint", `BigInt(8)+1n`},
		{"replace-all", `'a-b-c'.replaceAll('-','')`},
	} {
		t.Run(probe.name, func(t *testing.T) {
			vm := goja.New()
			value, err := vm.RunString(probe.source)
			if err != nil {
				t.Fatal(err)
			}
			t.Log(value)
		})
	}
}

// Test the actual protocol ingress, not JSON.parse on data the protocol rejects.
// Goja's raw JSON.parse still normalizes lone surrogates; the shared strict
// scanner must reject original code units BEFORE that native decoder is invoked.
func TestJSONSurrogateParity(t *testing.T) {
	h := &runtimeHost{rootPath: "test"}
	h.vm = goja.New()
	h.vm.Set("__encode", func(s string) goja.ArrayBuffer { return h.vm.NewArrayBuffer([]byte(s)) })
	h.vm.Set("__decode", func(v goja.Value) string { return string(bytesArg(v)) })
	h.vm.Set("__random", nonce)
	if _, err := h.vm.RunString(`globalThis.TextEncoder=class{encode(s){return new Uint8Array(__encode(s))}};globalThis.TextDecoder=class{decode(b){return __decode(b)}};`); err != nil {
		t.Fatal(err)
	}
	source, err := assets.ReadFile("assets/core.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = h.vm.RunString(string(source)); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{`{"x":"\ud800"}`, `{"x":"\udc00"}`, `{"x":"\ud800x"}`, `{"x":"\ud800\ud800"}`, `{"\ud800":0}`, `{"a":1,"\u0061":2}`} {
		if _, err = h.call("parseProbe", h.vm.ToValue(input)); err == nil {
			t.Fatalf("accepted invalid original code units: %s", input)
		}
	}
	for _, input := range []string{`{"x":"\ud83d\ude00"}`, `{"x":"😀"}`, `{"x":"\\ud800"}`, `{"x":"Příliš žluťoučký"}`} {
		if _, err = h.call("parseProbe", h.vm.ToValue(input)); err != nil {
			t.Fatalf("valid JSON rejected: %s: %s", input, err)
		}
	}
}

func TestCLI(t *testing.T) {
	if !testFaults && validateArguments([]string{"--test-fault-file", t.TempDir()}) == nil {
		t.Fatal("production build accepts fault injection")
	}
	for _, args := range [][]string{{"--no-open", "--no-open"}, {"--host", "0.0.0.0"}, {"--store", "relative"}, {"--store"}, {"--recovery-root", "--no-open"}} {
		if validateArguments(args) == nil {
			t.Fatalf("accepted bad parameters: %v", args)
		}
	}
	if validateArguments([]string{"--no-open", "--help"}) != nil {
		t.Fatal("valid parameters rejected")
	}
	for _, url := range []string{"https://attacker.invalid/", "file:///tmp/file", "http://0.0.0.0:123/", "http://127.0.0.1:123/#omr-session=" + strings.Repeat("a", 64) + "&x=1"} {
		if _, err := browserCommand(url); err == nil {
			t.Fatal("accepted unsafe URL")
		}
	}
	if _, err := browserCommand("http://127.0.0.1:123/#omr-session=" + strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
}

func TestEmbeddedAssetsComplete(t *testing.T) {
	if err := validateEmbeddedAssets(); err != nil {
		t.Fatal(err)
	}
}

func TestArrayBufferBridge(t *testing.T) {
	vm := goja.New()
	payload := make([]byte, 1024*1024)
	payload[999999] = 173
	vm.Set("read", func() goja.ArrayBuffer { return vm.NewArrayBuffer(payload) })
	value, err := vm.RunString(`const bytes=new Uint8Array(read());bytes[999999]`)
	if err != nil || value.ToInteger() != 173 {
		t.Fatal("incorrect byte bridge", err)
	}
	// Creating the view does not iterate/copy one million Go values.
	if _, err = vm.RunString(`bytes[0]=23`); err != nil || payload[0] != 23 {
		t.Fatal("buffer backing not preserved", err)
	}
}

func TestActualAsyncRetryTimer(t *testing.T) {
	h := &runtimeHost{vm: goja.New(), stop: make(chan struct{})}
	h.installTimers()
	if _, err := h.vm.RunString(`globalThis.OMR={retry:async()=>{await new Promise(resolve=>setTimeout(resolve,30));return 7}}`); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	value, err := h.call("retry")
	if err != nil || value.ToInteger() != 7 {
		t.Fatal("async retry failed", err)
	}
	if time.Since(start) < 25*time.Millisecond {
		t.Fatal("timer did not wait")
	}
}
