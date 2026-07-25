import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { InputNameOverlay } from './UIOverlays';

describe('InputNameOverlay submission state', () => {
  it('exposes an accessible error and disables duplicate submission while busy', () => {
    const html = renderToStaticMarkup(
      <InputNameOverlay
        score={1200}
        playerName="Diver"
        setPlayerName={vi.fn()}
        isLoggedIn
        loginId="diver"
        error="Score submission failed. Please try again."
        isSubmitting
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Score submission failed. Please try again.');
    expect(html).toContain('disabled=""');
    expect(html).toContain('SUBMITTING…');
  });
});
