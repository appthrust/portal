package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/platformenv"
)

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	defaultStaticDir := os.Getenv("PORTAL_STATIC_DIR")
	if defaultStaticDir == "" {
		defaultStaticDir = "/srv/portal"
	}
	staticDir := flag.String("static-dir", defaultStaticDir, "static SPA directory")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("usage: portal-server [--listen :8080] [--static-dir /srv/portal]")
	}
	platform, err := platformenv.FromEnv()
	if err != nil {
		log.Fatal(err)
	}
	if err := platformenv.ValidateIdentityListen(*listen, platform.OIDCIssuer); err != nil {
		log.Fatal(err)
	}
	auth, err := identity.New(identity.FromEnv("PORTAL"))
	if err != nil {
		log.Fatal(err)
	}
	notices, closeStore := announcementsHandler(platform.APIURL, platform.ProjectID, auth)
	defer closeStore()
	handler, err := newHandler(*staticDir, platform.APIURL, platform.ProjectID, auth, nil, nil, notices)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	log.Printf("portal-server listening on %s", *listen)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
