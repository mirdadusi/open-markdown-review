package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

func validateArguments(args []string) error {
	seen := map[string]bool{}
	for i := 0; i < len(args); i++ {
		key := args[i]
		if seen[key] {
			return errors.New("repeated parameter: " + key)
		}
		seen[key] = true
		switch key {
		case "--help", "--licenses", "--no-open":
		case "--store", "--recovery-root", "--idle-ms", "--test-fault-file":
			if key == "--test-fault-file" && !testFaults {
				return errors.New("unknown parameter: " + key)
			}
			i++
			if i >= len(args) || strings.HasPrefix(args[i], "--") {
				return errors.New(key + " requires a value")
			}
			if key != "--idle-ms" && !filepath.IsAbs(args[i]) {
				return errors.New(key + " requires an absolute folder")
			}
		default:
			return errors.New("unknown parameter: " + key)
		}
	}
	return nil
}
func browserCommand(url string) (*exec.Cmd, error) {
	if !regexp.MustCompile(`^http://127\.0\.0\.1:[0-9]+/#omr-session=[a-f0-9]{64}$`).MatchString(url) {
		return nil, errors.New("refusing unexpected browser URL")
	}
	switch runtime.GOOS {
	case "windows":
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		if !filepath.IsAbs(root) {
			return nil, errors.New("invalid Windows system root")
		}
		return exec.Command(filepath.Join(root, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", url), nil
	case "darwin":
		return exec.Command("/usr/bin/open", url), nil
	case "linux":
		return exec.Command("xdg-open", url), nil
	default:
		return nil, errors.New("unsupported browser-opening platform")
	}
}
func openBrowser(url string) error {
	cmd, err := browserCommand(url)
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
