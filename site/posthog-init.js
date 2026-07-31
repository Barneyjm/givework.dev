// PostHog client-side initialization + the shared link-CTA tracking.
//
// Load order on every page (both in <head>):
//   <script src="/analytics-config.js"></script>   sets window.__POSTHOG_TOKEN__ / __POSTHOG_HOST__
//   <script src="/posthog-init.js"></script>       this file
//
// analytics-config.js is served by the Worker (src/app.ts) from the
// POSTHOG_PROJECT_TOKEN / POSTHOG_API_HOST environment variables, so the token
// never appears in committed code. __POSTHOG_HOST__ is the BROWSER ingest host:
// the managed reverse proxy (POSTHOG_PROXY_HOST, e.g. https://v.givework.dev)
// when one is configured — first-party, so ad-blockers that blanket-block
// *.posthog.com don't blank the funnel — and the direct PostHog host otherwise.
// With no token configured this file does
// nothing at all and `window.posthog` stays undefined — every capture site is
// guarded, so an unconfigured deploy is a no-op rather than a broken page.
//
// The link-CTA tracking lives HERE, once, rather than being copy-pasted into
// each page: one delegated listener on the document classifies every anchor
// click by href. Per-page scripts only capture what this cannot know (a board's
// task count, a conjecture's status), never link clicks.
(function () {
  var token = window.__POSTHOG_TOKEN__;
  var host = window.__POSTHOG_HOST__ || 'https://us.i.posthog.com';

  if (!token) {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      console.warn(
        'PostHog is not configured (POSTHOG_PROJECT_TOKEN is unset), so no events are being ' +
          'captured. This warning stops once the variable is set on the Worker.',
      );
    }
    return;
  }

  // PostHog snippet — loads posthog-js and initializes it. The loader derives
  // the script URL from api_host: on a *.i.posthog.com host the replace() below
  // swaps in the -assets CDN subdomain; on a reverse-proxy host it no-ops and
  // the script loads from <proxy>/static/array.js — which PostHog managed
  // proxies serve (verified against https://v.givework.dev/static/array.js:
  // 200, application/javascript). Either way the load path works unchanged.
  // biome-ignore format: vendored minified snippet, keep verbatim
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  var options = {
    api_host: host,
    defaults: '2026-05-30',
    // Anonymous visitors stay cheap anonymous events; only someone who is
    // explicitly identify()'d (a signed-in contributor) gets a person profile.
    person_profiles: 'identified_only',
  };
  // Behind the reverse proxy posthog-js cannot infer where the PostHog app
  // lives from api_host, so every link it builds (toolbar, "view in PostHog")
  // would point at the proxy. ui_host pins those links to the real app; on a
  // direct *.i.posthog.com host the library infers it correctly by itself.
  if (host.indexOf('.i.posthog.com') === -1) {
    options.ui_host = 'https://us.posthog.com';
  }

  posthog.init(token, options);

  // ---------------------------------------------------------------------------
  // Shared CTA tracking
  // ---------------------------------------------------------------------------

  // Which page the click happened on — the `source` property, so a funnel can
  // attribute a signup to the page that earned it.
  function pageSource() {
    var p = window.location.pathname.replace(/\/+$/, '') || '/';
    if (p === '' || p === '/' || p === '/index.html') return 'homepage';
    if (p === '/tasks' || p === '/tasks.html') return 'tasks_page';
    if (p === '/volunteers' || p === '/volunteers.html') return 'volunteers_page';
    if (p === '/contributors' || p === '/contributors.html') return 'contributors_page';
    if (p.indexOf('/contributors/') === 0) return 'contributor_page';
    if (p === '/conjectures' || p === '/conjectures.html') return 'conjectures_page';
    if (p.indexOf('/conjectures/') === 0) return 'conjecture_page';
    if (p === '/videos' || p === '/videos.html') return 'videos_page';
    return p;
  }

  // Chrome links (header nav, footer) are navigation, not campaign CTAs. Still
  // worth counting, but a funnel that cannot separate "clicked the hero button"
  // from "used the nav" is not measuring intent — so every event records where
  // on the page the anchor lived.
  function placement(a) {
    if (a.closest('header')) return 'nav';
    if (a.closest('footer')) return 'footer';
    return 'body';
  }

  var SOURCE = pageSource();

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var where = placement(a);

    // Ordered and mutually exclusive: first match wins, so one click is never
    // counted as two different CTAs.
    if (href.indexOf('auth/github/login') !== -1) {
      posthog.capture('contributor_signup_clicked', { source: SOURCE, placement: where });
      return;
    }
    if (href.indexOf('mailto:') === 0 && href.indexOf('proposal') !== -1) {
      posthog.capture('problem_proposal_clicked', { source: SOURCE, placement: where });
      return;
    }
    // A link into the work pool. On a conjecture detail page that is the
    // conjecture's own call to action, which answers a different question ("did
    // THIS conjecture send anyone to work?") than the site-wide one.
    if (/^\/tasks(\/|\?|$)/.test(href)) {
      if (SOURCE === 'conjecture_page') {
        posthog.capture('conjecture_task_cta_clicked', {
          slug: decodeURIComponent(window.location.pathname.split('/').pop() || ''),
          placement: where,
        });
      } else {
        posthog.capture('open_work_cta_clicked', { source: SOURCE, placement: where });
      }
      return;
    }
    // Click-through from the conjecture board to a detail page. Counted only on
    // the board itself; the same href elsewhere is navigation.
    if (SOURCE === 'conjectures_page' && /^\/conjectures\/[^/]+$/.test(href)) {
      posthog.capture('conjecture_card_clicked', {
        slug: decodeURIComponent(href.slice('/conjectures/'.length)),
        placement: where,
      });
    }
  });
})();
