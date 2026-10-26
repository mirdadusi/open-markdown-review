package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
)

func nonce() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func main() {
	if err := launch(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
