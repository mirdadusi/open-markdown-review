package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

func launch() error {
	if err := validateEmbeddedAssets(); err != nil {
		return err
	}
	rootFlag := flag.String("store", "", "explicit selected review root")
	privateFlag := flag.String("recovery-root", "", "private journals outside review")
	idleFlag := flag.Int("idle-ms", 600000, "idle timeout")
	noOpen := flag.Bool("no-open", false, "do not open browser")
	help := flag.Bool("help", false, "show usage")
	licenses := flag.Bool("licenses", false, "show licenses")
	fault := new(string)
	if testFaults {
		fault = flag.String("test-fault-file", "", "test build only: inject one partial write")
	}
	if err := validateArguments(os.Args[1:]); err != nil {
		return err
	}
	flag.Parse()
	if *help {
		fmt.Println("Open Markdown Review Go companion (candidate)\nStartReview [--store ABSOLUTE_REVIEW_FOLDER] [--recovery-root ABSOLUTE_PRIVATE_FOLDER] [--no-open]\nPlace beside manifest.json. Keep this launcher running. Only loopback connections are accepted.")
		return nil
	}
	if *licenses {
		for _, name := range []string{"assets/LICENSE", "assets/THIRD-PARTY-NOTICES.txt"} {
			b, err := assets.ReadFile(name)
			if err != nil {
				return err
			}
			fmt.Print(string(b), "\n")
		}
		return nil
	}
	if flag.NArg() != 0 {
		return errors.New("unsupported arguments")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	root := *rootFlag
	if root == "" {
		root = filepath.Dir(executable)
	}
	if !filepath.IsAbs(root) {
		return errors.New("review path must be absolute")
	}
	initial, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !initial.IsDir() || initial.Mode()&os.ModeSymlink != 0 {
		return errors.New("select a real review folder, not a symbolic link or junction")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	private := *privateFlag
	if private == "" {
		home, e := os.UserCacheDir()
		if e != nil {
			return e
		}
		private = filepath.Join(home, "open-markdown-review", "companion-go-recovery")
	}
	if !filepath.IsAbs(private) {
		return errors.New("recovery path must be absolute")
	}
	rel, err := filepath.Rel(root, private)
	if err != nil && filepath.VolumeName(root) == filepath.VolumeName(private) {
		return err
	}
	if err == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)) {
		return errors.New("recovery journals must stay outside review")
	}
	// Resolve the nearest existing ancestor before creating private journals.
	ancestor := private
	tail := []string{}
	for {
		_, e := os.Lstat(ancestor)
		if e == nil {
			break
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		tail = append([]string{filepath.Base(ancestor)}, tail...)
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return e
		}
		ancestor = parent
	}
	ancestor, err = filepath.EvalSymlinks(ancestor)
	if err != nil {
		return err
	}
	private = filepath.Join(append([]string{ancestor}, tail...)...)
	rel, err = filepath.Rel(root, private)
	if err == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)) {
		return errors.New("recovery journals must stay outside review")
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer r.Close()
	manifest, err := boundedRead(r, "manifest.json", 1048576)
	if err != nil {
		return err
	}
	mh := sha256.Sum256(manifest)
	h := &runtimeHost{root: r, rootPath: root, initial: initial, manifestHash: mh, journals: map[string]*os.Root{}, stop: make(chan struct{}), fault: *fault}
	defer func() {
		for _, timer := range h.timers {
			timer.Stop()
		}
	}()
	for _, scope := range []string{"client", "host"} {
		p := filepath.Join(private, hex.EncodeToString(mh[:]), scope)
		if err = os.MkdirAll(p, 0700); err != nil {
			return err
		}
		actual, e := filepath.EvalSymlinks(p)
		if e != nil || actual != p {
			return errors.New("private journal links are not allowed")
		}
		jr, e := os.OpenRoot(p)
		if e != nil {
			return e
		}
		defer jr.Close()
		h.journals[scope] = jr
	}
	if _, err = h.initialize(); err != nil {
		return err
	}
	if *idleFlag < 100 || *idleFlag > 86400000 {
		return errors.New("invalid idle timeout")
	}
	html, _ := assets.ReadFile("assets/toolbox.html")
	text := strings.Replace(string(html), "connect-src 'none'", "connect-src 'self'", 1)
	text = strings.Replace(text, "</head>", "<meta name=\"open-markdown-review-companion\" content=\"1\"></head>", 1)
	policyMatch := regexp.MustCompile(`<meta http-equiv="Content-Security-Policy" content="([^"]+)"`).FindStringSubmatch(text)
	if len(policyMatch) != 2 {
		return errors.New("trusted toolbox policy missing")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	origin := "http://" + listener.Addr().String()
	token := nonce()
	active := make(chan struct{}, 8)
	var reservedBodies atomic.Int64
	var timerMu sync.Mutex
	timer := time.NewTimer(time.Duration(*idleFlag) * time.Millisecond)
	defer timer.Stop()
	touch := func() { timerMu.Lock(); timer.Reset(time.Duration(*idleFlag) * time.Millisecond); timerMu.Unlock() }
	jsonReply := func(w http.ResponseWriter, status int, value any) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
	}
	server := &http.Server{ReadHeaderTimeout: 15 * time.Second, ReadTimeout: 120 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 16384}
	connections := newConnectionTracker()
	server.ConnState = connections.changed
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", policyMatch[1]+"; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		address, _, _ := net.SplitHostPort(q.RemoteAddr)
		if address != "127.0.0.1" || q.Host != listener.Addr().String() {
			jsonReply(w, 403, map[string]any{"ok": false})
			return
		}
		if connections.stopping.Load() {
			jsonReply(w, 503, map[string]any{"ok": false, "error": "The companion is stopping."})
			return
		}
		if q.Method == "GET" && q.URL.RequestURI() == "/" {
			if d := q.Header.Get("Sec-Fetch-Dest"); d != "" && d != "document" {
				jsonReply(w, 403, map[string]any{"ok": false})
				return
			}
			if o := q.Header.Get("Origin"); o != "" && o != origin {
				jsonReply(w, 403, map[string]any{"ok": false})
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, text)
			return
		}
		if q.Method == "GET" && q.URL.RequestURI() == "/favicon.ico" {
			w.WriteHeader(204)
			return
		}
		if q.URL.RequestURI() != "/api/rpc" {
			jsonReply(w, 404, map[string]any{"ok": false})
			return
		}
		if q.Method != "POST" || q.Header.Get("Origin") != origin || q.Header.Get("Content-Type") != "application/json" || q.Header.Get("Sec-Fetch-Site") != "" && q.Header.Get("Sec-Fetch-Site") != "same-origin" || subtle.ConstantTimeCompare([]byte(q.Header.Get("X-OMR-Session")), []byte(token)) != 1 {
			jsonReply(w, 403, map[string]any{"ok": false})
			return
		}
		select {
		case active <- struct{}{}:
			defer func() { <-active; touch() }()
		default:
			jsonReply(w, 429, map[string]any{"ok": false})
			return
		}
		touch()
		if q.ContentLength > maxBody {
			jsonReply(w, 413, map[string]any{"ok": false})
			return
		}
		reservation := q.ContentLength
		if reservation < 0 {
			reservation = maxBody
		}
		if reservation < 1 {
			reservation = 1
		}
		// Eight small polling/asset requests remain possible, but never buffer
		// eight maximum-size PDF bodies while they wait for the serialized VM.
		if reservedBodies.Add(reservation) > maxBody+(1<<20) {
			reservedBodies.Add(-reservation)
			jsonReply(w, 429, map[string]any{"ok": false, "error": "Local request memory budget is busy."})
			return
		}
		defer reservedBodies.Add(-reservation)
		b, e := io.ReadAll(io.LimitReader(q.Body, maxBody+1))
		if e != nil || int64(len(b)) > maxBody {
			jsonReply(w, 413, map[string]any{"ok": false})
			return
		}
		if len(b) > 0 && len(q.Header) > 32 {
			jsonReply(w, 413, map[string]any{"ok": false})
			return
		}
		if !utf8.Valid(b) {
			jsonReply(w, 200, map[string]any{"ok": false, "code": "invalid", "error": "invalid UTF-8"})
			return
		}
		h.mu.Lock()
		deadlineDone := make(chan struct{})
		deadline := time.AfterFunc(120*time.Second, func() { h.vm.Interrupt("Local operation exceeded the execution deadline."); close(deadlineDone) })
		value, e := h.call("request", h.vm.ToValue(string(b)))
		// Export while holding the VM lock. Native JSON encoding then owns a
		// detached Go value; it never walks live Goja objects concurrently.
		var exported any
		if e == nil {
			exported = value.Export()
		}
		if !deadline.Stop() {
			<-deadlineDone
		}
		h.vm.ClearInterrupt()
		h.mu.Unlock()
		if e != nil {
			jsonReply(w, 200, map[string]any{"ok": false, "code": "uncertain", "error": e.Error()})
			h.stopOnce.Do(func() { close(h.stop) }) // Never reuse a timed-out VM with pending jobs.
			return
		}
		payload, e := json.Marshal(exported)
		if e != nil {
			jsonReply(w, 200, map[string]any{"ok": false, "code": "uncertain", "error": "Could not encode the local operation response."})
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(payload)
	})
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	fmt.Println("Open Markdown Review Go companion\nKeep this launcher running. Stop with Ctrl+C or Stop local companion. No activity for ten minutes stops the helper.")
	url := origin + "/#omr-session=" + token
	if *noOpen {
		fmt.Println(url)
	} else if err := openBrowser(url); err != nil {
		fmt.Fprintln(os.Stderr, "Could not open the default browser. Open the private session URL below manually.")
		fmt.Println(url)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	for {
		select {
		case <-h.stop:
		case <-signals:
		case err := <-serveErrors:
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				return err
			}
		case <-timer.C:
			if len(active) > 0 {
				touch()
				continue
			}
		}
		break
	}
	ctx, cancel := context.WithTimeout(context.Background(), 130*time.Second)
	defer cancel()
	return connections.shutdown(ctx, server)
}
