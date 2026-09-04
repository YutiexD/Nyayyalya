/**
 * The common frame for every signed-in view: header, tab strip, and a single content
 * area that each tab renders into.
 *
 * The tab strip is not a router — there is no history to manage and no deep links to
 * keep working, so it is a list of render functions and an index. Keeping it that
 * small is the point of not shipping a framework here.
 */
import { requireSession, signOut } from '../lib/api.js';
import { el, mount, appHeader, clear } from '../lib/ui.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {string[]} [options.roles] roles permitted on this page
 * @param {Array<{id:string,label:string,render:(el:HTMLElement,ctx:object)=>void}>} options.tabs
 */
export function boot({ title, subtitle, roles, tabs }) {
  const session = requireSession(roles);
  if (!session) return null;

  const body = document.body;
  clear(body);

  const content = el('main', { id: 'content' });
  const strip = el('nav.tabs', { role: 'tablist' });

  const ctx = { session, content };
  let current = null;

  const show = (tab) => {
    current = tab.id;
    for (const btn of strip.children) {
      btn.setAttribute('aria-selected', btn.dataset.tab === tab.id ? 'true' : 'false');
    }
    clear(content);
    tab.render(content, ctx);
  };

  for (const tab of tabs) {
    strip.appendChild(
      el(
        'button.tabs__tab',
        {
          type: 'button',
          role: 'tab',
          dataset: { tab: tab.id },
          'aria-selected': 'false',
          onClick: () => show(tab),
        },
        tab.label
      )
    );
  }

  mount(
    body,
    appHeader({ title, subtitle, session, onSignOut: signOut }),
    strip,
    content
  );

  show(tabs[0]);

  ctx.goto = (id) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && tab.id !== current) show(tab);
    else if (tab) show(tab);
  };

  return ctx;
}
