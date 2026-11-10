package main

// Transactional mail: invitations and password resets, over SMTP.
//
// Built for Mailtrap (live.smtp.mailtrap.io:587, STARTTLS, user "api", the
// MAIL_TRAP token as the password), but any SMTP server with STARTTLS on 587
// or implicit TLS on 465 works. The From address must be on a domain the
// provider has verified, or every send is refused.
//
// Without a token and a From address the mailer is off: nothing is sent and
// the set-password link goes back to the administrator, as before.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// MailConfig is the SMTP account (from server/.env).
type MailConfig struct {
	Host      string
	Port      int
	User      string
	Password  string
	FromEmail string
	FromName  string
}

// Mail is one message: a plain-text body and the same in HTML, with any
// images the HTML shows as cid:<CID>.
type Mail struct {
	To      string
	ToName  string
	Subject string
	Text    string
	HTML    string
	Inline  []mailImage
}

// mailImage is an image sent inside the message, shown by the HTML.
type mailImage struct {
	CID  string // the HTML's src="cid:<CID>"
	Type string // image/png
	Name string
	Data []byte
}

// Mailer sends one message, or says why it could not.
type Mailer interface {
	Send(ctx context.Context, m Mail) error
}

// mailSendTimeout bounds one send, connect to QUIT: an administrator waits on
// it when inviting someone.
const mailSendTimeout = 20 * time.Second

type smtpMailer struct{ cfg MailConfig }

// NewMailer is the configured mailer, or nil when mail is off.
func NewMailer(c MailConfig) Mailer {
	if c.Password == "" || c.FromEmail == "" || c.Host == "" {
		return nil
	}
	return &smtpMailer{cfg: c}
}

func (s *smtpMailer) Send(ctx context.Context, m Mail) error {
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("mail: bad recipient: %w", err)
	}
	msg, err := buildMessage(s.cfg, m, time.Now())
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, mailSendTimeout)
	defer cancel()
	addr := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
	tlsCfg := &tls.Config{ServerName: s.cfg.Host, MinVersion: tls.VersionTLS12}
	d := &net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	if s.cfg.Port == 465 {
		conn, err = (&tls.Dialer{NetDialer: d, Config: tlsCfg}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("mail: connect %s: %w", addr, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("mail: greeting: %w", err)
	}
	defer c.Close()

	if s.cfg.Port != 465 {
		// Never send the password in the clear.
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("mail: the server does not offer STARTTLS")
		}
		if err := c.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("mail: STARTTLS: %w", err)
		}
	}
	if s.cfg.User != "" {
		if err := c.Auth(smtp.PlainAuth("", s.cfg.User, s.cfg.Password, s.cfg.Host)); err != nil {
			return fmt.Errorf("mail: sign-in: %w", err)
		}
	}
	// G707: FromEmail is checked as a bare address when the config loads.
	if err := c.Mail(s.cfg.FromEmail); err != nil { //nolint:gosec // see above
		return fmt.Errorf("mail: from: %w", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return fmt.Errorf("mail: to: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("mail: data: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("mail: data: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("mail: data: %w", err)
	}
	return c.Quit()
}

// mailReason names a failed send the way the dashboard's invite notices
// expect: "provider-quota" when the provider says try later (Mailtrap
// refuses the sign-in with 535 once the day's quota is spent; 421 and 450-452
// are SMTP's own "try later"), "send-failed" otherwise.
func mailReason(err error) string {
	var te *textproto.Error
	if errors.As(err, &te) {
		msg := strings.ToLower(te.Msg)
		if te.Code == 421 || te.Code >= 450 && te.Code <= 452 ||
			te.Code == 535 && (strings.Contains(msg, "limit") || strings.Contains(msg, "quota")) {
			return "provider-quota"
		}
	}
	return "send-failed"
}

// noCRLF keeps a header value on one line: no header injection.
func noCRLF(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
}

// buildMessage is the RFC 5322 message: headers, then the text and HTML
// bodies as multipart/alternative, both quoted-printable. With inline images
// the HTML and its images go together as multipart/related:
//
//	multipart/alternative
//	├─ text/plain
//	└─ multipart/related
//	   ├─ text/html
//	   └─ image/png (Content-ID)
func buildMessage(c MailConfig, m Mail, now time.Time) ([]byte, error) {
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return nil, fmt.Errorf("mail: bad recipient: %w", err)
	}
	from := mail.Address{Name: noCRLF(c.FromName), Address: c.FromEmail}
	rcpt := mail.Address{Name: noCRLF(m.ToName), Address: to.Address}
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	domain := c.FromEmail[strings.LastIndex(c.FromEmail, "@")+1:]
	boundary := "samad-" + hex.EncodeToString(id)

	var b bytes.Buffer
	h := func(k, v string) { fmt.Fprintf(&b, "%s: %s\r\n", k, v) }
	h("From", from.String())
	h("To", rcpt.String())
	h("Subject", mime.QEncoding.Encode("utf-8", noCRLF(m.Subject)))
	h("Date", now.Format(time.RFC1123Z))
	h("Message-ID", "<"+hex.EncodeToString(id)+"@"+domain+">")
	h("MIME-Version", "1.0")
	h("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")

	fmt.Fprintf(&b, "--%s\r\n", boundary)
	if err := writeTextPart(&b, "text/plain", m.Text); err != nil {
		return nil, err
	}
	fmt.Fprintf(&b, "--%s\r\n", boundary)
	if len(m.Inline) == 0 {
		if err := writeTextPart(&b, "text/html", m.HTML); err != nil {
			return nil, err
		}
	} else {
		related := boundary + "-r"
		fmt.Fprintf(&b, "Content-Type: multipart/related; boundary=\"%s\"\r\n\r\n", related)
		fmt.Fprintf(&b, "--%s\r\n", related)
		if err := writeTextPart(&b, "text/html", m.HTML); err != nil {
			return nil, err
		}
		for _, img := range m.Inline {
			fmt.Fprintf(&b, "--%s\r\n", related)
			fmt.Fprintf(&b, "Content-Type: %s; name=\"%s\"\r\n", noCRLF(img.Type), noCRLF(img.Name))
			fmt.Fprintf(&b, "Content-Transfer-Encoding: base64\r\nContent-ID: <%s>\r\n", noCRLF(img.CID))
			fmt.Fprintf(&b, "Content-Disposition: inline; filename=\"%s\"\r\n\r\n", noCRLF(img.Name))
			enc := base64.StdEncoding.EncodeToString(img.Data)
			for len(enc) > 76 {
				b.WriteString(enc[:76] + "\r\n")
				enc = enc[76:]
			}
			b.WriteString(enc + "\r\n")
		}
		fmt.Fprintf(&b, "--%s--\r\n", related)
	}
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return b.Bytes(), nil
}

// writeTextPart writes one quoted-printable text part, headers and body.
func writeTextPart(b *bytes.Buffer, kind, body string) error {
	fmt.Fprintf(b, "Content-Type: %s; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n", kind)
	qp := quotedprintable.NewWriter(b)
	if _, err := qp.Write([]byte(strings.ReplaceAll(body, "\n", "\r\n"))); err != nil {
		return err
	}
	if err := qp.Close(); err != nil {
		return err
	}
	b.WriteString("\r\n")
	return nil
}
