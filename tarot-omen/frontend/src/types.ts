import type { DrawnCard } from './data/cards';

export type Screen = 'question' | 'reveal' | 'interpretation';

export interface InterpretRequestCard {
  position: string;
  name: string;
  orientation: 'upright' | 'reversed';
  keywords: string;
}

export interface InterpretRequestBody {
  question: string;
  cards: InterpretRequestCard[];
  initData?: string;
}

export interface InterpretResponse {
  interpretation: string;
}

export function toInterpretRequestCards(drawn: DrawnCard[], positions: readonly { key: string; label: string }[]): InterpretRequestCard[] {
  return drawn.map((d, i) => ({
    position: positions[i].label,
    name: d.card.name,
    orientation: d.orientation,
    keywords: d.orientation === 'upright' ? d.card.upright : d.card.reversed,
  }));
}
