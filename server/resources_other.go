//go:build !linux

package main

// Off Linux only the Go runtime figures are read; the rest stay unknown.
func readResources(string) resourceSample { return resourceSample{} }
