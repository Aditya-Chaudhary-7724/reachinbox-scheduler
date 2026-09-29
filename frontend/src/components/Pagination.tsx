import { ChevronLeftIcon, ChevronRightIcon } from './icons';
import { Button } from './ui/Button';

export function Pagination({
  page,
  totalPages,
  total,
  limit,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  limit: number;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3 text-sm text-gray-500">
      <span>
        <span className="font-medium text-gray-700">{from.toLocaleString()}</span>–
        <span className="font-medium text-gray-700">{to.toLocaleString()}</span> of{' '}
        <span className="font-medium text-gray-700">{total.toLocaleString()}</span>
      </span>
      {totalPages > 1 ? (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            icon={<ChevronLeftIcon width={16} height={16} />}
            aria-label="Previous page"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
            icon={<ChevronRightIcon width={16} height={16} />}
            aria-label="Next page"
          />
        </div>
      ) : null}
    </div>
  );
}
