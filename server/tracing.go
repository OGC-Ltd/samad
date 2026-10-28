package main

// Tracing, through OpenTelemetry, to Jaeger (or anything that takes OTLP).
//
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT (or ..._TRACES_ENDPOINT) is set, and
// configured by the standard OTEL_* variables beyond that: OTEL_TRACES_SAMPLER
// / OTEL_TRACES_SAMPLER_ARG to sample less than every request. With it on,
// each request is a span named for its route, and every call to the Partner
// API, Google and OpenAI is a child span under it, so a slow screen opens in
// Jaeger as "which outside call made it slow".

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gorilla/mux"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// tracingOn is set once at start, before any request is served.
var tracingOn bool

// setupTracing starts the exporter when one is configured. The returned
// function flushes what is buffered; call it on the way out.
func setupTracing(ctx context.Context) func(context.Context) error {
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" && os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") == "" {
		return func(context.Context) error { return nil }
	}
	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		log.Printf("tracing off: %v", err)
		return func(context.Context) error { return nil }
	}
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		attribute.String("service.name", env("OTEL_SERVICE_NAME", "samad-server")),
		attribute.String("service.version", version),
	))
	if err != nil {
		res = resource.Default()
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	tracingOn = true
	log.Printf("tracing on: OTLP export")
	return tp.Shutdown
}

// traceRequests opens the server span for each request. Health probes and
// scrapes are left out: every few seconds forever, and nothing to learn.
func traceRequests(h http.Handler) http.Handler {
	if !tracingOn {
		return h
	}
	return otelhttp.NewHandler(h, "samad-server",
		otelhttp.WithFilter(func(r *http.Request) bool {
			return r.URL.Path != "/api/v1/health" && r.URL.Path != "/metrics" &&
				!strings.HasPrefix(r.URL.Path, "/assets/")
		}))
}

// traced adds a client span to an outside call. Without a provider the
// global one is a no-op, so this costs nothing while tracing is off.
func traced(rt http.RoundTripper, service string) http.RoundTripper {
	return otelhttp.NewTransport(rt, otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
		return service + " " + r.Method
	}))
}

// nameSpan renames the server span for the matched route, once routing has
// happened (otelhttp opens it before), and returns the trace id for the log.
func nameSpan(r *http.Request, route string) string {
	span := trace.SpanFromContext(r.Context())
	sc := span.SpanContext()
	if !sc.IsValid() {
		return ""
	}
	span.SetName(r.Method + " " + route)
	span.SetAttributes(attribute.String("http.route", route))
	return sc.TraceID().String()
}

// matchedTemplate is the route the router matched, as its template.
func matchedTemplate(r *http.Request) string {
	if rt := mux.CurrentRoute(r); rt != nil {
		if t, err := rt.GetPathTemplate(); err == nil {
			return t
		}
	}
	return ""
}
