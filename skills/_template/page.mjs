// The page seat: a screen on the dashboard, rendered on the server, inside
// the house chrome (header, nav, job strip, the default-src 'none' CSP).
// Delete this file if your skill contributes no screen.
//
// You may import anything from ../../lib/ to read the store — for example:
//   import { store } from "../../lib/store.mjs";
//   ...inside render: const S = store(ctx.dir); S.items(); ...
// A render that throws shows its failure on the page; it cannot take the
// dashboard down. Escape anything you print that a stranger wrote — the
// dashboard's rule is that every Reddit-sourced string goes through esc().

export default {
  path: "/example",   // one lowercase segment; core paths are refused at mount
  title: "Example",   // the nav label and the <title>
  nav: true,          // false keeps it reachable but off the nav
  render: ({ dir }) => `
    <h1>Example</h1>
    <p class="sub">Reading ${dir} — replace this with something worth a screen.</p>
  `,
};
