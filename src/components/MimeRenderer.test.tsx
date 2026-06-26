import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MimeRenderer } from './MimeRenderer';

// Stub the heavy children so the test stays focused on layout rules.
vi.mock('./SecureIframe', () => ({ SecureIframe: () => <div data-testid="iframe" /> }));
vi.mock('./TruthArtifactPreview', () => ({
  TruthArtifactPreview: () => <div data-testid="artifact" />,
}));
vi.mock('./MlbOddsDashboard', () => ({ MlbOddsDashboard: () => <div data-testid="dash" /> }));

describe('MimeRenderer hydration safety (FIX #5)', () => {
  it('never nests a <div> or <pre> inside a <p>', () => {
    const md = 'Intro paragraph.\n\n```html\n<h1>artifact</h1>\n```\n\nClosing text.';
    const { container } = render(<MimeRenderer content={md} />);
    // No <p> in the tree should contain a block-level <div>/<pre> descendant.
    container.querySelectorAll('p').forEach((p) => {
      expect(p.querySelector('div, pre')).toBeNull();
    });
  });

  it('renders a complete <!DOCTYPE html> document as a live artifact, not raw text', () => {
    const md = '```html\n<!DOCTYPE html>\n<html><head><title>T</title></head><body><h1>hi</h1></body></html>\n```';
    const { getByTestId, container } = render(<MimeRenderer content={md} />);
    // Must mount the interactive preview, NOT dump source into a <pre>.
    expect(getByTestId('artifact')).toBeTruthy();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('renders an mlb-odds-dashboard fence as the native component', () => {
    const { getByTestId } = render(
      <MimeRenderer content={'```mlb-odds-dashboard\n```'} />,
    );
    expect(getByTestId('dash')).toBeTruthy();
  });

  it('reports decode errors via onError instead of throwing', () => {
    const onError = vi.fn();
    render(<MimeRenderer content="data:application/vnd.google-apps.mail;base64,!!!" onError={onError} />);
    expect(onError).toHaveBeenCalled();
  });
});
