package directory

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/link"
	"github.com/appthrust/appserver-go/appserver/platformclient"
	"github.com/stretchr/testify/require"
)

func linked(url string) *link.Client {
	resolver := link.NewResolver(platformclient.New("http://127.0.0.1:1", "pj-test"), "intranet-portal", func(key string) (string, bool) {
		return url, key == "PORTAL_DIRECTORY_URL" && url != ""
	}, map[string]link.Required{"directory": {URLEnv: "PORTAL_DIRECTORY_URL"}})
	return link.NewClient(resolver, nil)
}

func TestDisplayNameComesFromTheCallersDirectoryProfileAndIsCachedPerBearer(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, "/api/directory/v1/me", r.URL.Path)
		name := map[string]string{"Bearer alex": " 山田 太郎 ", "Bearer sam": "Sam"}[r.Header.Get("Authorization")]
		httpx.WriteJSON(w, 200, map[string]any{"person": map[string]any{"id": "p", "displayName": name}, "effectiveGroupIds": []string{}, "roles": map[string]any{}})
	}))
	defer server.Close()
	now := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	client := New(linked(server.URL), func() time.Time { return now })
	for range 2 {
		require.Equal(t, "山田 太郎", client.DisplayName(t.Context(), "Bearer alex"))
	}
	require.EqualValues(t, 1, calls.Load())
	require.Equal(t, "Sam", client.DisplayName(t.Context(), "Bearer sam"))
	require.EqualValues(t, 2, calls.Load())
	now = now.Add(knownFor)
	require.Equal(t, "山田 太郎", client.DisplayName(t.Context(), "Bearer alex"))
	require.EqualValues(t, 3, calls.Load())
}

func TestDisplayNameIsEmptyWithoutDirectoryAndAsksAgainOnlyAfterAWhile(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	now := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	client := New(linked(server.URL), func() time.Time { return now })
	require.Empty(t, client.DisplayName(t.Context(), "Bearer alex"))
	require.Empty(t, client.DisplayName(t.Context(), "Bearer alex"))
	require.EqualValues(t, 1, calls.Load())
	now = now.Add(unknownFor)
	require.Empty(t, client.DisplayName(t.Context(), "Bearer alex"))
	require.EqualValues(t, 2, calls.Load())
	require.Empty(t, New(nil, time.Now).DisplayName(t.Context(), "Bearer alex"))
}
