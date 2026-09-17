import { BOOK_LABEL, type BookId } from '../../shared/types.js';
import { BOOK_SHORT } from '../format.js';

/** "DK" / "FD" chip in the book's colour, used wherever a value's source matters. */
export function BookBadge({ book, full = false }: { book: BookId; full?: boolean }) {
  return (
    <span className={`book-badge book-badge--${book}`} title={BOOK_LABEL[book]}>
      {full ? BOOK_LABEL[book] : BOOK_SHORT[book]}
    </span>
  );
}
