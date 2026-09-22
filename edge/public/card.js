/* ─────────────────────────────────────────────────────────────────────────────
 * FUT card rendering.
 *
 * Draws a player the way the game shows it: rating and position top left, name
 * across the bottom, club / league / nation beneath, and a treatment matching
 * the card type.
 *
 * The cards are drawn in CSS rather than using EA's artwork — their card images
 * and player faces are theirs. If an image base is configured in Settings the
 * cards will use real faces and badges; with none set they stand on their own.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

/**
 * Map a card to its visual treatment.
 *
 * Special types win outright. Everything else falls back to the metal tier the
 * game uses, which is decided by rating: gold from 75, silver from 65, bronze
 * below that — so a common 84 renders gold, not as an untyped card.
 */
function cardClass(player) {
  switch (player.cardType) {
    case 'icon':      return 'icon';
    case 'hero':      return 'hero';
    case 'totw':      return 'totw';
    case 'promo':     return 'promo';
    case 'evolution': return 'evolution';
    case 'rare':      return player.rating >= 75 ? 'rare' : metalTier(player.rating);
    default:          return metalTier(player.rating);
  }
}

function metalTier(rating) {
  if (rating >= 75) return 'gold';
  if (rating >= 65) return 'silver';
  return 'bronze';
}

/** Short club / league / nation line, skipping anything the export omitted. */
function metaLine(player) {
  return [player.clubName, player.leagueName, player.nationName]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Render one player card.
 *
 * `opts.price` adds the coin figure at the foot; `opts.wanted` renders the
 * outlined "you need to buy this" variant instead of a real card.
 */
function playerCard(player, opts = {}) {
  const cls = opts.wanted ? 'wanted' : cardClass(player);
  const classes = ['fut-card', cls];
  if (opts.price !== undefined && opts.price !== null) classes.push('has-price');

  const children = [
    el('div', { class: 'rating' }, player.rating),
    el('div', { class: 'pos' }, player.position?.primary ?? '—'),
    el('div', { class: 'spacer' }),
    el('div', { class: 'name', title: player.name }, player.name),
  ];

  const meta = metaLine(player);
  if (meta) children.push(el('div', { class: 'meta', title: meta }, meta));

  // Only one corner flag, worst-first: a protected card being in a squad is
  // the thing to notice, and stacking badges just makes the card unreadable.
  if (opts.wanted) {
    children.push(el('div', { class: 'flag buy' }, 'BUY'));
  } else if (player.isProtected) {
    children.push(el('div', {
      class: 'flag prot',
      title: (player.protectionReasons || []).join('; ') || 'protected',
    }, 'LOCK'));
  } else if (player.isDuplicate) {
    children.push(el('div', {
      class: 'flag dup',
      title: `${player.duplicateCount} copies owned`,
    }, `×${player.duplicateCount}`));
  }

  if (!opts.wanted && player.tradeability === 'untradeable') {
    children.push(el('div', { class: 'untradeable', title: 'Untradeable' }, 'UT'));
  }

  if (opts.price !== undefined && opts.price !== null) {
    children.push(el('div', { class: 'price' }, `${n(opts.price)}`));
  }

  return el('div', {
    class: classes.join(' '),
    title: cardTooltip(player, opts),
  }, ...children);
}

function cardTooltip(player, opts) {
  if (opts.wanted) return `Needs buying: ${player.rating} rated`;
  const bits = [
    `${player.name} — ${player.rating} ${player.position?.primary ?? ''}`.trim(),
    player.cardType,
    player.tradeability,
  ];
  if (player.isDuplicate) bits.push(`${player.duplicateCount} owned`);
  if (player.isProtected) bits.push(`PROTECTED: ${(player.protectionReasons || []).join('; ')}`);
  if (opts.rationale) bits.push(opts.rationale);
  return bits.filter(Boolean).join('\n');
}

/**
 * Render a whole squad as a row of cards.
 *
 * Ordered most expensive first, so the cards worth a second look are the ones
 * your eye lands on first.
 */
function squadCards(rows, missing = []) {
  const cards = rows.map((row) =>
    playerCard(row.player, { price: row.value, rationale: row.rationale }));

  // Cards the club cannot supply sit at the end, outlined rather than filled.
  for (const m of missing) {
    cards.push(playerCard(
      { rating: m.rating, name: 'Any player', position: { primary: '—' }, cardType: 'common' },
      { wanted: true, price: m.estimatedCost },
    ));
  }

  return el('div', { class: 'cards' }, ...cards);
}
