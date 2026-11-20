import { mount } from 'svelte';
import Fixture from './Fixture.svelte';
import InviteFixture from './InviteFixture.svelte';
import sansUrl from '../../src/lib/fonts/QerithSans-latin.woff2?url';
import monoUrl from '../../src/lib/fonts/FragmentMono-Regular-latin.woff2?url';

if (new URLSearchParams(window.location.search).has('listing')) {
  const unicodeRange = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD';
  const faces = [
    { url: sansUrl, face: new FontFace('Qerith Sans', `url(${JSON.stringify(sansUrl)})`, { weight: '200 900', stretch: '75% 125%', display: 'swap', unicodeRange }) },
    { url: monoUrl, face: new FontFace('Fragment Mono', `url(${JSON.stringify(monoUrl)})`, { weight: '400', display: 'optional', unicodeRange }) }
  ];
  // Register loaded faces so optional display does not race the font download.
  // The listing can render with its existing fallback stack while requests settle.
  window.fixtureFonts = Promise.allSettled(faces.map(async ({ face }) => {
    document.fonts.add(await face.load());
  })).then(() => faces);
}

mount(new URLSearchParams(window.location.search).has('invite') ? InviteFixture : Fixture, { target: document.getElementById('app') });
