package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestRepeatedSpeculativeShutdown(t *testing.T) {
	for i := 0; i < 40; i++ {
		tracker := newConnectionTracker()
		server := &http.Server{ConnState: tracker.changed, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })}
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		served := make(chan error, 1)
		go func() { served <- server.Serve(listener) }()
		raw, err := net.Dial("tcp4", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err = tracker.shutdown(ctx, server)
		cancel()
		_ = raw.Close()
		if err != nil {
			t.Fatalf("shutdown %d failed: %v", i, err)
		}
		if err = <-served; !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("unexpected serve exit: %v", err)
		}
	}
}
func TestShutdownDrainsActiveRequest(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	tracker := newConnectionTracker()
	server := &http.Server{ConnState: tracker.changed, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte("saved"))
	})}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go server.Serve(listener)
	client := &http.Client{Timeout: 3 * time.Second}
	result := make(chan string, 1)
	go func() {
		response, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			result <- err.Error()
			return
		}
		defer response.Body.Close()
		b, err := io.ReadAll(response.Body)
		if err != nil {
			result <- err.Error()
			return
		}
		result <- string(b)
	}()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	closed := make(chan error, 1)
	go func() { closed <- tracker.shutdown(ctx, server) }()
	select {
	case err := <-closed:
		t.Fatalf("active request was not drained: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if body := <-result; body != "saved" {
		t.Fatalf("active response lost: %s", body)
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
}
