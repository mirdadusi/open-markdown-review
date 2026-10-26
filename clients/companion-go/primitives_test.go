package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/dop251/goja"
)

func TestNativeSHA256VectorsAndTypedArrayViews(t *testing.T) {
	vm := goja.New()
	vm.Set("__sha256", func(value goja.Value) goja.ArrayBuffer { return nativeSHA256(vm, value) })
	for _, vector := range []struct{ input, expected string }{
		{"", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
		{"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
	} {
		vm.Set("payload", vm.NewArrayBuffer([]byte(vector.input)))
		value, err := vm.RunString(`new Uint8Array(__sha256(new Uint8Array(payload)))`)
		if err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(bytesArg(value)); got != vector.expected {
			t.Fatalf("hash mismatch: %s", got)
		}
	}
	for _, length := range []int{0, 1, 55, 56, 63, 64, 65, 1024, 1048576} {
		payload := make([]byte, length+18)
		for i := range payload {
			payload[i] = byte(i % 251)
		}
		vm.Set("payload", vm.NewArrayBuffer(payload))
		vm.Set("end", 9+length)
		value, err := vm.RunString(`new Uint8Array(__sha256(new Uint8Array(payload).subarray(9,end)))`)
		if err != nil {
			t.Fatal(err)
		}
		expected := sha256.Sum256(payload[9 : 9+length])
		if !bytes.Equal(bytesArg(value), expected[:]) {
			t.Fatalf("subarray hash mismatch at length %d", length)
		}
	}
}

// The comparison driver generates expectations using the ordinary, unaliased
// Node parser. These include explicit links, images, tables, Mermaid and HTML.
func TestEmbeddedMarkdownParity(t *testing.T) {
	file := os.Getenv("OMR_GO_MARKDOWN_VECTORS")
	if file == "" {
		t.Skip("Run scripts/test-go-markdown-parity.mjs")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Document, Source, Profile string
		Expected                  json.RawMessage
		Error                     string
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 16 {
		t.Fatal("incomplete parity vectors")
	}
	vm := goja.New()
	vm.Set("__random", nonce)
	vm.Set("__encode", func(value string) goja.ArrayBuffer { return vm.NewArrayBuffer([]byte(value)) })
	vm.Set("__sha256", func(value goja.Value) goja.ArrayBuffer { return nativeSHA256(vm, value) })
	if _, err := vm.RunString(`globalThis.TextEncoder=class{encode(value){return new Uint8Array(__encode(value))}}`); err != nil {
		t.Fatal(err)
	}
	core, err := assets.ReadFile("assets/core.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = vm.RunString(string(core)); err != nil {
		t.Fatal(err)
	}
	fn, ok := goja.AssertFunction(vm.Get("OMR").ToObject(vm).Get("semanticsProbe"))
	if !ok {
		t.Fatal("missing trusted probe")
	}
	for i, vector := range vectors {
		value, err := fn(goja.Undefined(), vm.ToValue(vector.Document), vm.ToValue(vector.Source), vm.ToValue(vector.Profile))
		if vector.Error != "" {
			if err == nil {
				t.Fatalf("vector %d unexpectedly admitted", i)
			}
			continue
		}
		if err != nil {
			t.Fatalf("vector %d: %v", i, err)
		}
		actual, err := json.Marshal(value.Export())
		if err != nil {
			t.Fatal(err)
		}
		var expectedValue, actualValue any
		if err = json.Unmarshal(vector.Expected, &expectedValue); err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(actual, &actualValue); err != nil {
			t.Fatal(err)
		}
		expected, _ := json.Marshal(expectedValue)
		normalized, _ := json.Marshal(actualValue)
		if !bytes.Equal(expected, normalized) {
			t.Fatalf("semantic mismatch in vector %d:\n%s\n%s", i, expected, normalized)
		}
	}
}

func TestEmbeddedCoreActuallyUsesNativeSHA256(t *testing.T) {
	vm := goja.New()
	calls := 0
	vm.Set("__random", nonce)
	vm.Set("__encode", func(value string) goja.ArrayBuffer { return vm.NewArrayBuffer([]byte(value)) })
	vm.Set("__sha256", func(value goja.Value) goja.ArrayBuffer { calls++; return nativeSHA256(vm, value) })
	if _, err := vm.RunString(`globalThis.TextEncoder=class{encode(value){return new Uint8Array(__encode(value))}}`); err != nil {
		t.Fatal(err)
	}
	core, err := assets.ReadFile("assets/core.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = vm.RunString(string(core)); err != nil {
		t.Fatal(err)
	}
	value, err := vm.RunString(`OMR.digestProbe(new TextEncoder().encode('abc'))`)
	if err != nil {
		t.Fatal(err)
	}
	if value.String() != "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" || calls != 1 {
		t.Fatal("shared digest did not use exactly one native SHA-256 call")
	}
}
