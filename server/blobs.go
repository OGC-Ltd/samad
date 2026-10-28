package main

// Uploaded files (group logos): in a private S3 bucket when S3_BUCKET is set,
// otherwise in a folder under DATA_DIR. Either way the server hands them out
// itself, behind the sign-in, so the bucket is never public.
//
// On the box, S3 credentials come from the instance's IAM role (preferred)
// or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in server/.env; the role needs
// s3:PutObject, s3:GetObject and s3:DeleteObject on <bucket>/<prefix>*.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

var errNoBlob = errors.New("no such file")

type Blobs interface {
	Put(ctx context.Context, key string, data []byte, contentType string) error
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
}

// NewBlobs is S3 when the config names a bucket, the disk otherwise.
func NewBlobs(cfg Config) (Blobs, error) {
	if cfg.S3Bucket == "" {
		return newDiskBlobs(filepath.Join(cfg.DataDir, "files"))
	}
	ac, err := awsconfig.LoadDefaultConfig(context.Background(), awsconfig.WithRegion(cfg.S3Region))
	if err != nil {
		return nil, fmt.Errorf("S3: %w", err)
	}
	return s3Blobs{client: s3.NewFromConfig(ac), bucket: cfg.S3Bucket, prefix: cfg.S3Prefix}, nil
}

// ── the disk ──

// diskBlobs reaches its folder through an os.Root: no key, link or ".." can
// lead outside it.
type diskBlobs struct{ root *os.Root }

func newDiskBlobs(dir string) (diskBlobs, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return diskBlobs{}, err
	}
	root, err := os.OpenRoot(dir)
	return diskBlobs{root: root}, err
}

func (d diskBlobs) Put(_ context.Context, key string, data []byte, _ string) error {
	if err := d.root.MkdirAll(path.Dir(key), 0o750); err != nil {
		return err
	}
	tmp := key + ".tmp"
	if err := d.root.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return d.root.Rename(tmp, key)
}

func (d diskBlobs) Get(_ context.Context, key string) ([]byte, error) {
	b, err := d.root.ReadFile(key)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errNoBlob
	}
	return b, err
}

func (d diskBlobs) Delete(_ context.Context, key string) error {
	if err := d.root.Remove(key); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ── S3 ──

type s3Blobs struct {
	client *s3.Client
	bucket string
	prefix string
}

func (b s3Blobs) key(k string) *string { return aws.String(strings.TrimLeft(b.prefix+k, "/")) }

func (b s3Blobs) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := b.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(b.bucket), Key: b.key(key),
		Body: bytes.NewReader(data), ContentType: aws.String(contentType),
		ServerSideEncryption: types.ServerSideEncryptionAes256,
	})
	return err
}

func (b s3Blobs) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := b.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(b.bucket), Key: b.key(key)})
	var missing *types.NoSuchKey
	if errors.As(err, &missing) {
		return nil, errNoBlob
	}
	if err != nil {
		return nil, err
	}
	defer out.Body.Close()
	return io.ReadAll(io.LimitReader(out.Body, maxLogoBytes+1))
}

func (b s3Blobs) Delete(ctx context.Context, key string) error {
	_, err := b.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(b.bucket), Key: b.key(key)})
	return err
}
