// Small line icons (24×24, stroke = currentColor) for icon-only buttons. Emoji render differently on
// every platform, so the UI uses these instead.
const PATHS = {
  volume: 'M11 5 6 9H3v6h3l5 4V5z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13',
  mute: 'M11 5 6 9H3v6h3l5 4V5z M22 9l-6 6 M16 9l6 6',
  user: 'M20 21a8 8 0 0 0-16 0 M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  first: 'M18 6l-6 6 6 6 M7 6v12',
  prev: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  last: 'M6 6l6 6-6 6 M17 6v12',
  prevKey: 'M17 6l-6 6 6 6 M11 6l-6 6 6 6',
  nextKey: 'M7 6l6 6-6 6 M13 6l6 6-6 6',
  flip: 'M7 4v16 M3 8l4-4 4 4 M17 20V4 M13 16l4 4 4-4',
  fullscreen: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  close: 'M6 6l12 12 M18 6 6 18',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  back: 'M19 12H5 M11 6l-6 6 6 6',
  home: 'M3 10.5 12 3l9 7.5 M5 9v12h5v-6h4v6h5V9',
  play: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 8v8 M8 12h8',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 12h.01',
};

export function icon(name, { size = 18, label = null } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  if (label) svg.setAttribute('aria-label', label);
  else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name]);
  svg.appendChild(path);
  return svg;
}
