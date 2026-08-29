import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CREATE_FLAG_PARAM } from '../lib/createActions';

// True while `?create=1` is in the URL, then strips it. Reads `searchParams` per render, not
// a `useState` lazy initializer — StageHeader's create button re-navigates to this same route
// (query only), so the page never remounts and a lazy initializer would only fire once.
export function useCreateFlag(): boolean {
  const [searchParams, setSearchParams] = useSearchParams();
  const shouldCreate = searchParams.get(CREATE_FLAG_PARAM) === '1';

  useEffect(() => {
    if (!shouldCreate) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(CREATE_FLAG_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [shouldCreate, setSearchParams]);

  return shouldCreate;
}
