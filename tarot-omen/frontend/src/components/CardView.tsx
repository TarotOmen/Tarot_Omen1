import type { DrawnCard } from '../data/cards';

interface Props {
  drawn: DrawnCard | null;
  flipped: boolean;
}

export function CardView({ drawn, flipped }: Props) {
  const reversedClass = drawn?.orientation === 'reversed' ? ' reversed' : '';
  return (
    <div className={`tarot-card${flipped ? ' flipped' : ''}${reversedClass}`}>
      <div className="tarot-card-inner">
        <div className="tarot-card-face tarot-card-back" />
        <div className="tarot-card-face tarot-card-front">
          {drawn && (
            <>
              <div className="tarot-card-glyph" />
              <div className="tarot-card-name">{drawn.card.name}</div>
              <div className="tarot-card-orientation">
                {drawn.orientation === 'upright' ? 'Upright' : 'Reversed'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
