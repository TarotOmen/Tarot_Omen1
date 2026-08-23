import { useEffect, useRef, useState } from 'react';
import { POSITIONS, type DrawnCard } from '../data/cards';
import { CardView } from './CardView';
import { toInterpretRequestCards, type InterpretResponse } from '../types';
import { getInitData, shareResult } from '../telegram';

interface Props {
  question: string;
  cards: DrawnCard[];
  onAskAnother: () => void;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

export function InterpretationScreen({ question, cards, onAskAnother }: Props) {
  const [interpretation, setInterpretation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;

    const body = {
      question,
      cards: toInterpretRequestCards(cards, POSITIONS),
      initData: getInitData(),
    };

    fetch(`${API_BASE}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        return (await res.json()) as InterpretResponse;
      })
      .then((data) => setInterpretation(data.interpretation))
      .catch(() => setError('The reading could not be reached. Please try again in a moment.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleShare = () => {
    const summary = cards.map((c, i) => `${POSITIONS[i].label}: ${c.card.name}${c.orientation === 'reversed' ? ' (reversed)' : ''}`).join('\n');
    shareResult(`Tarot Omen reading\n\n${summary}`);
  };

  return (
    <div className="screen interp-screen">
      <div>
        <p className="brand">Tarot Omen</p>
        <div className="brand-hair" />
      </div>

      <p className="interp-question">“{question}”</p>

      <div className="spread interp-cards">
        {cards.map((drawn, i) => (
          <div className="spread-slot" key={drawn.card.id}>
            <span className="spread-label">{POSITIONS[i].label}</span>
            <CardView drawn={drawn} flipped />
          </div>
        ))}
      </div>

      {loading && (
        <div className="interp-loading">
          <div className="spinner" />
          <span>Reading the cards…</span>
        </div>
      )}

      {!loading && error && <p className="interp-error">{error}</p>}

      {!loading && interpretation && <div className="interp-body">{interpretation}</div>}

      <div className="actions">
        <button className="btn-secondary" onClick={onAskAnother}>
          Ask Another Question
        </button>
        <button className="btn-primary" onClick={handleShare}>
          Share
        </button>
      </div>
    </div>
  );
}
