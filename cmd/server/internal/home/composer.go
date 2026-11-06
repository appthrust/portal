// Package home composes installed built-in apps and capability-provided launch entries.
package home

import (
	"cmp"
	"context"
	"log/slog"
	"net/url"
	"slices"
	"sync"
	"time"

	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/launcherentries"
	"github.com/appthrust/appserver-go/appserver/link"
)

const (
	cacheTTL    = 60 * time.Second
	maxSubjects = 1024
)

type Page struct {
	Project          launcher.Project `json:"project"`
	AppInstallations []launcher.Entry `json:"builtinApps"`
	Sections         []Section        `json:"sections"`
	Sources          []Source         `json:"sources"`
}

type Entry struct {
	launcherentries.Entry
	SourceDefinitionID string `json:"sourceDefinitionId"`
}

type Section struct {
	Relation launcherentries.EntryRelation `json:"relation"`
	Group    *launcherentries.GroupRef     `json:"group"`
	Entries  []Entry                       `json:"entries"`
}

type Source struct {
	DefinitionID string `json:"definitionId"`
	State        string `json:"state"`
}

type cachedPage struct {
	page    Page
	expires time.Time
}

// Composer caches complete unfiltered pages per viewer, never per Project.
// Providers alone decide entry visibility, relation, state, URLs and search.
type Composer struct {
	catalog  *launcher.Catalog
	resolver *link.Resolver
	client   *link.Client
	now      func() time.Time
	mu       sync.Mutex
	cache    map[string]cachedPage
}

func New(catalog *launcher.Catalog, resolver *link.Resolver, client *link.Client, now func() time.Time) *Composer {
	if now == nil {
		now = time.Now
	}
	return &Composer{catalog: catalog, resolver: resolver, client: client, now: now, cache: make(map[string]cachedPage)}
}

// Home returns caller-owned data. Only empty-query pages are cached for 60 s;
// provider failures affect their source, while Platform API failures fail Home.
func (c *Composer) Home(ctx context.Context, subject, bearer, q string) (Page, error) {
	if q == "" {
		c.mu.Lock()
		cached, found := c.cache[subject]
		if found && c.now().Before(cached.expires) {
			page := clonePage(cached.page)
			c.mu.Unlock()
			return page, nil
		}
		c.mu.Unlock()
	}

	snapshot, err := c.catalog.Load(ctx, subject, bearer)
	if err != nil {
		return Page{}, err
	}
	bindings, err := c.resolver.ByCapability(ctx, bearer, launcherentries.Capability)
	if err != nil {
		return Page{}, err
	}
	page := Page{
		Project: snapshot.Project, AppInstallations: snapshot.Entries,
		Sections: make([]Section, 0), Sources: make([]Source, len(bindings)),
	}
	entries := make([][]launcherentries.Entry, len(bindings))
	params := link.Params{Query: url.Values{"q": {q}}}
	var pending sync.WaitGroup
	for i, binding := range bindings {
		page.Sources[i] = Source{DefinitionID: binding.Definition, State: "absent"}
		if binding.State != link.StateReady {
			continue
		}
		// One request per Ready binding; the binding set bounds concurrency and
		// the shared link client supplies each request's timeout.
		pending.Add(1)
		go func() {
			defer pending.Done()
			var result launcherentries.EntryList
			if err := c.client.DoAt(ctx, bearer, binding, launcherentries.ListEntries, params, nil, &result); err != nil {
				page.Sources[i].State = "unavailable"
				// Error values can contain provider response bodies; do not log them.
				slog.DebugContext(ctx, "Portal entry provider unavailable", "definition", binding.Definition)
				return
			}
			page.Sources[i].State = "ready"
			entries[i] = result.Items
		}()
	}
	pending.Wait()

	type sectionKey struct {
		relation launcherentries.EntryRelation
		groupID  string
	}
	sections := make(map[sectionKey]int)
	for i, items := range entries {
		for _, item := range items {
			key := sectionKey{relation: item.Relation}
			var group *launcherentries.GroupRef
			if item.Relation == launcherentries.Group && item.Group != nil {
				group = item.Group
				key.groupID = group.ID
			}
			index, found := sections[key]
			if !found {
				index = len(page.Sections)
				sections[key] = index
				page.Sections = append(page.Sections, Section{Relation: item.Relation, Group: group})
			}
			page.Sections[index].Entries = append(page.Sections[index].Entries, Entry{
				Entry: item, SourceDefinitionID: bindings[i].Definition,
			})
		}
	}
	slices.SortFunc(page.Sections, func(a, b Section) int {
		if order := cmp.Compare(relationOrder(a.Relation), relationOrder(b.Relation)); order != 0 {
			return order
		}
		if a.Group != nil && b.Group != nil {
			if order := cmp.Compare(a.Group.Path, b.Group.Path); order != 0 {
				return order
			}
			return cmp.Compare(a.Group.ID, b.Group.ID)
		}
		return 0
	})
	for _, section := range page.Sections {
		slices.SortFunc(section.Entries, func(a, b Entry) int {
			if order := cmp.Compare(a.Name, b.Name); order != 0 {
				return order
			}
			if order := cmp.Compare(a.SourceDefinitionID, b.SourceDefinitionID); order != 0 {
				return order
			}
			return cmp.Compare(a.ID, b.ID)
		})
	}

	if q == "" {
		c.mu.Lock()
		if _, found := c.cache[subject]; !found && len(c.cache) >= maxSubjects {
			var oldestSubject string
			var oldestExpiry time.Time
			for key, entry := range c.cache {
				if oldestExpiry.IsZero() || entry.expires.Before(oldestExpiry) {
					oldestSubject, oldestExpiry = key, entry.expires
				}
			}
			delete(c.cache, oldestSubject)
		}
		c.cache[subject] = cachedPage{page: clonePage(page), expires: c.now().Add(cacheTTL)}
		c.mu.Unlock()
	}
	return page, nil
}

func relationOrder(relation launcherentries.EntryRelation) int {
	switch relation {
	case launcherentries.Owner:
		return 0
	case launcherentries.Group:
		return 1
	default:
		return 2
	}
}

func clonePage(page Page) Page {
	page.AppInstallations = slices.Clone(page.AppInstallations)
	page.Sources = slices.Clone(page.Sources)
	page.Sections = slices.Clone(page.Sections)
	for i := range page.Sections {
		section := &page.Sections[i]
		if section.Group != nil {
			group := *section.Group
			section.Group = &group
		}
		section.Entries = slices.Clone(section.Entries)
		for j := range section.Entries {
			entry := &section.Entries[j]
			entry.Tags = slices.Clone(entry.Tags)
			if entry.Group != nil {
				group := *entry.Group
				entry.Group = &group
			}
		}
	}
	return page
}
