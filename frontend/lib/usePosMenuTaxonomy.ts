import { useCallback, useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import {
  activePosMenuCategories,
  committedPosMenuTaxonomy,
  resolvePosMenuTaxonomy,
  type PosMenuTaxonomy,
  type ResolvedPosMenuTaxonomy,
} from './posMenuTaxonomy';

type PosMenuTaxonomyState = ResolvedPosMenuTaxonomy & {
  categories: ReturnType<typeof activePosMenuCategories>;
  loading: boolean;
  error: string;
  setEffectiveTaxonomy: (taxonomy: PosMenuTaxonomy) => void;
};

export function usePosMenuTaxonomy(): PosMenuTaxonomyState {
  const [resolved, setResolved] = useState<ResolvedPosMenuTaxonomy>(() => ({
    taxonomy: committedPosMenuTaxonomy(),
    source: 'fallback',
  }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => onSnapshot(doc(db, 'appSettings', 'posMenuTaxonomy'), (snapshot) => {
    setResolved(resolvePosMenuTaxonomy(snapshot.exists() ? snapshot.data() : null));
    setLoading(false);
    setError('');
  }, () => {
    setResolved({ taxonomy: committedPosMenuTaxonomy(), source: 'fallback' });
    setLoading(false);
    setError('The saved taxonomy could not be read. The committed fallback is in use.');
  }), []);

  const categories = useMemo(
    () => activePosMenuCategories(resolved.taxonomy),
    [resolved.taxonomy],
  );
  const setEffectiveTaxonomy = useCallback((taxonomy: PosMenuTaxonomy) => {
    setResolved({ taxonomy, source: 'firestore' });
    setLoading(false);
    setError('');
  }, []);

  return { ...resolved, categories, loading, error, setEffectiveTaxonomy };
}
