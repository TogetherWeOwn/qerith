<script>
  import SignInPage from '../../src/lib/SignInPage.svelte';
  import EmptyFolder from '../../src/lib/EmptyFolder.svelte';
  import RowActions from '../../src/lib/RowActions.svelte';
  import FileList from '../../src/lib/FileList.svelte';
  import DetailsFixture from './DetailsFixture.svelte';

  const details = new URLSearchParams(window.location.search).get('details');
  const menuFixture = new URLSearchParams(window.location.search).get('menu');
  const rowName = new URLSearchParams(window.location.search).get('name') ?? (new URLSearchParams(window.location.search).has('longName') ? 'a'.repeat(200) : 'Sample file');
  let firstName;
  let nextName;
  let menu;
  let selected = $state('');
  let mounted = $state(true); window.addEventListener('fixture-unmount-menu', () => { mounted = false; });
  const recordBoundary = callback => { document.body.dataset[callback] = String(!!document.querySelector('dialog:modal')); };
  function tabFromMenu(direction) {
    recordBoundary('tabModal');
    document.body.dataset.tabDirection = direction;
    if (new URLSearchParams(window.location.search).has('native-tab')) {
      document.body.dataset.tabLayerOpen = String(!!document.querySelector('dialog:modal, dialog:popover-open'));
      return false;
    }
    if (menuFixture === 'throw') throw new Error('Fixture onTab error');
    (direction === 'next' ? nextName : firstName).focus();
    if (menuFixture === 'file') return true;
  }

  const listing = new URLSearchParams(window.location.search).has('listing');
  const items = [
    { id: '1', name: 'Archive', href: '#archive', kind: 'Folder', glyph: 'folder-shared', size: '—', bytes: null, modified: '14 Nov', modifiedAt: '2026-11-14T09:00:00Z', shared: true },
    { id: '3', name: 'a-very-long-file-name-without-breaks-to-check-reflow.txt', href: '#long', kind: 'File', glyph: 'file', size: '1.0 KB', bytes: 1000, modified: '12 Nov', modifiedAt: '2026-11-12T09:00:00Z', shared: false },
    { id: '2', name: 'Résumé 2025.pdf', href: '#resume', kind: 'PDF', glyph: 'document', size: '5.4 MB', bytes: 5400000, modified: '13 Nov', modifiedAt: '2026-11-13T09:00:00Z', shared: false }
  ];
  const detailsItems = items.map(item => ({ ...item, owned: true, details: { modifiedFull: '14 November 2026, 09:00 UTC', uploaded: '12 November 2026, 09:00 UTC', ...(item.shared ? { sharedWith: ['Mora', 'Sam'] } : {}) } }));
  const whitespaceItems = [
    { ...items[1], id: 'spaces', name: 'report  final.txt', href: '#spaces' },
    { ...items[1], id: 'tab', name: '\t', href: '#tab' }
  ];
  const unicodeItems = [
    { ...items[1], id: 'unicode', name: 'áááááááááááá👩‍👩‍👧‍👦.txt', href: '#unicode' },
    { ...items[1], id: 'rtl', name: 'تقرير-الميزانية-السنوية-النهائية.pdf', href: '#rtl' },
    { ...items[1], id: 'invoice', name: 'invoice-february.pdf', href: '#invoice' },
    { ...items[1], id: 'accented-long', name: 'Résumé-budget-annuel-version-finale.pdf', href: '#accented-long' },
    { ...items[1], id: 'emoji-modifier', name: 'annual-budget-👍🏽-final-report.pdf', href: '#emoji-modifier' },
    { ...items[1], id: 'emoji-flag', name: 'annual-budget-🇺🇸-final-report.pdf', href: '#emoji-flag' },
    { ...items[1], id: 'accented-terminal', name: 'budget-annuel-résumé.pdf', href: '#accented-terminal' },
    { ...items[1], id: 'emoji-terminal', name: 'annual-budget-👍🏽.pdf', href: '#emoji-terminal' },
    { ...items[1], id: 'decomposed', name: 'Résumé-café-final-report.pdf', href: '#decomposed' },
    { ...items[1], id: 'accented-terminal-long', name: 'budget-annuel-version-finale-résumé.pdf', href: '#accented-terminal-long' },
    { ...items[1], id: 'emoji-terminal-long', name: 'annual-budget-version-final-report-👍🏽.pdf', href: '#emoji-terminal-long' },
    { ...items[1], id: 'decomposed-long', name: 'Résumé-café-version-finale-annual-report.pdf', href: '#decomposed-long' },
    { ...items[1], id: 'tatweel', name: 'ب'.repeat(10) + 'ـ' + 'ب'.repeat(5) + '.pdf', href: '#tatweel' },
    { ...items[1], id: 'mixed-bidi', name: 'تقرير-annual-budget.pdf', href: '#mixed-bidi' },
    { ...items[1], id: 'bidi-control', name: 'annual-' + String.fromCodePoint(0x202e) + 'budget-report.pdf', href: '#bidi-control' },
    { ...items[1], id: 'bidi-digits', name: 'annual-١٢٣٤٥٦٧٨٩-report.pdf', href: '#bidi-digits' },
    { ...items[1], id: 'bidi-punctuation', name: 'annual-־budget-report.pdf', href: '#bidi-punctuation' },
    { ...items[1], id: 'bidi-suffix', name: 'report.' + 'ב'.repeat(20), href: '#bidi-suffix' },
    { ...items[1], id: 'khmer', name: 'ក'.repeat(10) + 'ក្' + 'ក'.repeat(5) + '.pdf', href: '#khmer' },
    { ...items[1], id: 'kannada', name: 'ಕ'.repeat(10) + 'ಕ್' + 'ಕ'.repeat(5) + '.pdf', href: '#kannada' },
    { ...items[1], id: 'wide-suffix', name: 'abcdefghijklmnop.' + '界'.repeat(15), href: '#wide-suffix' },
    { ...items[1], id: 'zwj-modifier', name: 'annual-👩🏽‍💻-final-report.pdf', href: '#zwj-modifier' },
    { ...items[1], id: 'accent-dot', name: 'resume-café.pdf', href: '#accent-dot' },
    { ...items[1], id: 'ascii-255', name: 'a'.repeat(251) + '.txt', href: '#ascii-255' },
    { ...items[1], id: 'cjk', name: '年度予算報告書'.repeat(4) + '.pdf', href: '#cjk' },
    { ...items[1], id: 'edge-spaces', name: '  leading  and trailing  ', href: '#edge-spaces' },
    { ...items[1], id: 'only-spaces', name: '   ', href: '#only-spaces' }
  ];
  // Synthetic pages exercise the controlled list without a route or identity.
  const paged = new URLSearchParams(window.location.search).has('paged');
  const pagedItems = Array.from({ length: 401 }, (_, index) => ({
    ...items[1], id: `page-${index}`, name: `File ${String(index).padStart(3, '0')}.txt`, href: `#page-${index}`
  }));
  let direction = $state('asc');
  let shown = $state(200);
  let loadMoreError = $state(false);
  let loadingMore = $state(false);
  let pageRequests = $state(0);
  let failNextPage = new URLSearchParams(window.location.search).has('page-error');
  let visiblePage = $derived((direction === 'asc' ? pagedItems : [...pagedItems].reverse()).slice(0, shown));
  function sortPage(next) { if (!new URLSearchParams(window.location.search).has('reject-sort')) { direction = next; shown = 200; loadMoreError = false; } }
  function showMore() {
    pageRequests++;
    if (new URLSearchParams(window.location.search).has('page-pending')) { loadingMore = true; return; }
    if (failNextPage) { failNextPage = false; loadMoreError = true; return; }
    loadMoreError = false;
    shown += 200;
  }
  window.addEventListener('fixture-page-complete', () => { loadingMore = false; shown += 200; });
  const empty = new URLSearchParams(window.location.search).get('empty');
  let uploads = $state(0);

  let requests = $state(0);
  let cancellations = $state(0);
  let signInState = $state(new URLSearchParams(window.location.search).get('state') || 'sign-in');
  window.addEventListener('fixture-wait', () => { signInState = 'waiting'; });
  window.addEventListener('fixture-state', event => { signInState = event.detail; });
</script>

{#if details === 'full' || details === 'missing' || details === 'zero' || details === 'one'}
  <main><DetailsFixture variant={details} /></main>
{:else if menuFixture}
  <main>
    <div class:clipped={new URLSearchParams(window.location.search).has('clipped')} oncontextmenu={(event) => menu.openFromContextMenu(event)} role="presentation">
      <button bind:this={firstName}>Sample file</button>
      {#if mounted}
        <RowActions bind:this={menu} name={rowName} file={menuFixture !== 'folder'} owned={menuFixture !== 'shared'} onAction={(action) => { recordBoundary('actionModal'); selected = action; }} onTab={tabFromMenu} />
      {/if}
    </div>
    <button bind:this={nextName}>Next file</button>
    <p aria-live="polite">{selected}</p>
  </main>
{:else if listing && new URLSearchParams(window.location.search).has('two-lists')}
  <main><div style="width: 500px"><FileList folder="First" timeZone="UTC" {items} /></div><div style="width: 500px"><FileList folder="Second" timeZone="UTC" {items} /></div></main>
{:else if listing}
  <main>{#if paged}<h1>My Drive</h1><p>{pagedItems.length} items</p><FileList folder="My Drive" timeZone="America/New_York" items={visiblePage} {direction} total={new URLSearchParams(window.location.search).has('unknown-total') ? undefined : pagedItems.length} hasMore={shown < pagedItems.length} {loadMoreError} {loadingMore} onSort={sortPage} onMore={showMore} />{:else if new URLSearchParams(window.location.search).has('details')}<FileList folder="My Drive" timeZone="America/New_York" items={new URLSearchParams(window.location.search).has('missing-details') ? items : detailsItems} onAction={(_id, action) => { selected = action; }} /><button>After listing</button>{:else}<FileList folder="My Drive" timeZone="America/New_York" items={new URLSearchParams(window.location.search).has('unicode') ? unicodeItems : new URLSearchParams(window.location.search).has('whitespace') ? whitespaceItems : items} />{/if}</main>
{:else if empty}
  <main><EmptyFolder root={empty === 'root'} onUpload={() => uploads++} /></main>
{:else}
  <SignInPage state={signInState} onSignIn={() => requests++} onCancel={() => cancellations++} />
{/if}
<output hidden data-requests={requests} data-cancellations={cancellations} data-uploads={uploads} data-page-requests={pageRequests}></output>

<style>
  main { min-height: 100vh; background: var(--drive-color-bg-canvas); }
  .clipped { height: 48px; overflow: hidden; }
</style>
