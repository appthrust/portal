// Package directory reads the caller's own Directory profile through the
// installation's Directory link, with the caller's bearer.
package directory

import (
	"context"
	"crypto/sha256"
	"strings"
	"sync"
	"time"

	contract "github.com/appthrust/appserver-go/appserver/contract/directory"
	"github.com/appthrust/appserver-go/appserver/link"
)

const (
	// A name is decoration: never hold a page for it longer than this.
	lookupTimeout = 3 * time.Second
	knownFor      = 5 * time.Minute
	// Directory absent or failing: ask again soon, but not on every request.
	unknownFor = 30 * time.Second
	maxEntries = 512
)

type entry struct {
	name    string
	expires time.Time
}

// Client resolves display names. The cache is keyed by a hash of the bearer,
// so it never stores a credential.
type Client struct {
	links *link.Client
	now   func() time.Time
	mu    sync.Mutex
	cache map[[sha256.Size]byte]entry
}

func New(links *link.Client, now func() time.Time) *Client {
	return &Client{links: links, now: now, cache: map[[sha256.Size]byte]entry{}}
}

// DisplayName is the caller's Directory profile name, or "" when Directory is
// not linked, has no profile for the caller, or does not answer in time.
func (c *Client) DisplayName(ctx context.Context, bearer string) string {
	if c == nil || c.links == nil {
		return ""
	}
	key := sha256.Sum256([]byte(bearer))
	now := c.now()
	c.mu.Lock()
	cached, found := c.cache[key]
	c.mu.Unlock()
	if found && now.Before(cached.expires) {
		return cached.name
	}
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()
	var me contract.MeResponse
	name, ttl := "", unknownFor
	if err := c.links.Do(ctx, bearer, contract.Me, link.Params{}, nil, &me); err == nil {
		if name = strings.TrimSpace(me.Person.DisplayName); name != "" {
			ttl = knownFor
		}
	}
	c.mu.Lock()
	for existing, value := range c.cache {
		if !now.Before(value.expires) {
			delete(c.cache, existing)
		}
	}
	if len(c.cache) >= maxEntries {
		for oldest := range c.cache {
			delete(c.cache, oldest)
			break
		}
	}
	c.cache[key] = entry{name: name, expires: now.Add(ttl)}
	c.mu.Unlock()
	return name
}
