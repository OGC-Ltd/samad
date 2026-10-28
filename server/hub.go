package main

// The live stream: every connected browser gets each frame the poller
// produces. A slow client is skipped rather than allowed to hold the others.

import "sync"

type Frame struct {
	Event string
	Data  []byte
}

type Hub struct {
	mu   sync.Mutex
	subs map[chan Frame]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan Frame]struct{}{}} }

func (h *Hub) Subscribe() chan Frame {
	ch := make(chan Frame, 256)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

// Count is how many live streams are open now.
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

func (h *Hub) Unsubscribe(ch chan Frame) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *Hub) Publish(f Frame) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- f:
		default: // full: this client is behind, drop the frame for it
		}
	}
}
