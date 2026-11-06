package home

import (
	"encoding/json"
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/appthrust/appserver-go/appserver/httpx"
	"github.com/appthrust/appserver-go/appserver/identity"
	"github.com/appthrust/appserver-go/appserver/launcher"
	"github.com/appthrust/appserver-go/appserver/link"
)

// NewHandler serves GET /api/portal/v1/home with the shared launcher's viewer
// authentication rules. Search text is delegated unchanged to providers.
func NewHandler(composer *Composer, authenticate launcher.AuthenticateFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			httpx.WriteError(w, httpx.Fail(http.StatusMethodNotAllowed, "method_not_allowed", "Only GET is supported"), "portal")
			return
		}
		header := r.Header.Get("Authorization")
		if header == "" {
			httpx.WriteError(w, httpx.Fail(http.StatusUnauthorized, "unauthenticated", "A bearer token is required"), "portal")
			return
		}
		claims, bearer, err := authenticate(r.Context(), header)
		if err != nil {
			if errors.Is(err, identity.ErrUnavailable) {
				httpx.WriteError(w, httpx.Fail(http.StatusServiceUnavailable, "identity_unavailable", "Identity verification is unavailable"), "portal")
			} else if errors.Is(err, identity.ErrRawKeyNotAccepted) {
				httpx.WriteError(w, httpx.Fail(http.StatusUnauthorized, "raw_key_not_accepted", "Exchange the access key for an assertion before calling this API"), "portal")
			} else {
				httpx.WriteError(w, httpx.Fail(http.StatusUnauthorized, "unauthenticated", "A valid bearer token is required"), "portal")
			}
			return
		}
		if claims.Principal.Kind == "key" {
			httpx.WriteError(w, httpx.Fail(http.StatusForbidden, "key_not_permitted", "Access keys cannot list the built-in app launcher"), "portal")
			return
		}
		q := r.URL.Query().Get("q")
		if utf8.RuneCountInString(q) > 128 {
			httpx.WriteError(w, httpx.Fail(http.StatusBadRequest, "invalid_query", "q must not exceed 128 characters"), "portal")
			return
		}
		page, err := composer.Home(r.Context(), claims.Principal.Subject, bearer, q)
		if err != nil {
			var catalogDenied *launcher.DeniedError
			var resolverDenied *link.DeniedError
			switch {
			case errors.As(err, &catalogDenied):
				err = httpx.Fail(catalogDenied.Status, "forbidden", "You do not have permission to list this Project's built-in apps")
			case errors.As(err, &resolverDenied):
				err = httpx.Fail(resolverDenied.Status, "forbidden", "You do not have permission to list this Project's built-in apps")
			default:
				err = httpx.Fail(http.StatusServiceUnavailable, "portal_unavailable", "The employee portal is unavailable")
			}
			httpx.WriteError(w, err, "portal")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "private, no-store")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(page)
	})
}
