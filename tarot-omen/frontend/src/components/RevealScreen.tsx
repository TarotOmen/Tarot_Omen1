import { useEffect, useRef, useState } from 'react';
import { drawThreeCards, POSITIONS, type DrawnCard } from '../data/cards';
import { CardView } from './CardView';
import { haptic } from '../telegram';

interface Props {
  onDone: (cards: DrawnCard[]) => void;
}

const SHUFFLE_MS = 1600;
const FLIP_GAP_MS = 550;
const HOLD_AFTER_LAST_MS = 850;

export function RevealScreen({ onDone }: Props) {
  const [settled, setSettled] = useState(false);
  const [cards, setCards] = useState<DrawnCard[] | null>(null);
  const [flippedCount, setFlippedCount] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    // Cards are drawn by the client-side RNG immediately — before any AI call.
    const drawn = drawThreeCards();

    const t1 = window.setTimeout(() => {
      setSettled(true);
      setCards(drawn);
    }, SHUFFLE_MS);
    timers.current.push(t1);

    return () => timers.current.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!cards) return;
    // Reveal one card at a time.
    for (let i = 0; i < cards.length; i++) {
      const t = window.setTimeout(() => {
        setFlippedCount((c) => c + 1);
        haptic('medium');
      }, i * FLIP_GAP_MS);
      timers.current.push(t);
    }
    const tDone = window.setTimeout(() => {
      onDone(cards);
    }, cards.length * FLIP_GAP_MS + HOLD_AFTER_LAST_MS);
    timers.current.push(tDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  return (
    <div className="screen reveal-screen">
      {!settled && (
        <>
          <div className="deck-stage">
            <div className="deck-card c2" />
            <div className="deck-card c1" />
            <div className="deck-card c0" />
          </div>
          <p className="reveal-status">Shuffling the deck…</p>
        </>
      )}

      {settled && cards && (
        <div className="spread">
          {cards.map((drawn, i) => (
            <div className="spread-slot" key={drawn.card.id}>
              <span className="spread-label">{POSITIONS[i].label}</span>
              <CardView drawn={drawn} flipped={i < flippedCount} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
