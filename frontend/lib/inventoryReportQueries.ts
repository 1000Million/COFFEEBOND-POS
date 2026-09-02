import {
  collection,
  Firestore,
  orderBy,
  query,
  Query,
  QueryConstraint,
  Timestamp,
  where,
} from 'firebase/firestore';
import { ReportDateRange } from './reportDateRange';

export type InventoryEventCollection = 'orders' | 'kotItems' | 'stockMovements';

export type InventoryEventQueryPlan = {
  collectionName: InventoryEventCollection;
  storeId: string;
  startInclusive: Date;
  endExclusive: Date;
  createdAtOrder?: 'desc';
};

export function createInventoryEventQueryPlans(
  storeId: string,
  range: Pick<ReportDateRange, 'startInclusive' | 'endExclusive'>,
): Record<InventoryEventCollection, InventoryEventQueryPlan> {
  if (!storeId) throw new Error('Inventory report queries require an authorized store.');

  const base = {
    storeId,
    startInclusive: range.startInclusive,
    endExclusive: range.endExclusive,
  };

  return {
    orders: { ...base, collectionName: 'orders' },
    kotItems: { ...base, collectionName: 'kotItems' },
    stockMovements: {
      ...base,
      collectionName: 'stockMovements',
      // Matches the deployed storeId ASC + createdAt DESC composite index.
      createdAtOrder: 'desc',
    },
  };
}

function buildQuery(firestore: Firestore, plan: InventoryEventQueryPlan): Query {
  const constraints: QueryConstraint[] = [
    where('storeId', '==', plan.storeId),
    where('createdAt', '>=', Timestamp.fromDate(plan.startInclusive)),
    where('createdAt', '<', Timestamp.fromDate(plan.endExclusive)),
  ];
  if (plan.createdAtOrder) constraints.push(orderBy('createdAt', plan.createdAtOrder));
  return query(collection(firestore, plan.collectionName), ...constraints);
}

export function buildInventoryEventQueries(
  firestore: Firestore,
  storeId: string,
  range: Pick<ReportDateRange, 'startInclusive' | 'endExclusive'>,
): Record<InventoryEventCollection, Query> {
  const plans = createInventoryEventQueryPlans(storeId, range);
  return {
    orders: buildQuery(firestore, plans.orders),
    kotItems: buildQuery(firestore, plans.kotItems),
    stockMovements: buildQuery(firestore, plans.stockMovements),
  };
}
