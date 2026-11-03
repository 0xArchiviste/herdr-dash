//go:build !desktop

package main

import (
	"context"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "routing" {
		os.Exit(routingMain(os.Args[2:]))
	}
	o := defineServerFlags()
	flag.Parse()
	if o.sttFetch {
		if err := o.fetchSTT(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := o.finish(); err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	d, err := newDashServer(ctx, o, nil)
	if err != nil {
		log.Fatal(err)
	}
	l, err := net.Listen("tcp", o.addr)
	if err != nil {
		log.Fatal(err)
	}
	if err := d.serve(ctx, l); err != nil {
		log.Fatal(err)
	}
}
