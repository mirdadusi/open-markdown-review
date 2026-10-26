package main

import (
	"context"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
)

type connectionTracker struct {
	mu       sync.Mutex
	states   map[net.Conn]http.ConnState
	stopping atomic.Bool
}

func newConnectionTracker() *connectionTracker {
	return &connectionTracker{states: map[net.Conn]http.ConnState{}}
}
func (t *connectionTracker) changed(c net.Conn, state http.ConnState) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if state == http.StateClosed || state == http.StateHijacked {
		delete(t.states, c)
	} else {
		t.states[c] = state
	}
	if t.stopping.Load() && (state == http.StateNew || state == http.StateIdle) {
		go c.Close()
	}
}
func (t *connectionTracker) shutdown(ctx context.Context, server *http.Server) error {
	t.stopping.Store(true)
	server.SetKeepAlivesEnabled(false)
	// Close speculative sockets, not active saves. Never close the raw listener:
	// Server.Shutdown owns it; a double close intermittently returns net.ErrClosed.
	t.mu.Lock()
	var idle []net.Conn
	for c, state := range t.states {
		if state == http.StateNew || state == http.StateIdle {
			idle = append(idle, c)
		}
	}
	t.mu.Unlock()
	for _, c := range idle {
		_ = c.Close()
	}
	return server.Shutdown(ctx)
}
