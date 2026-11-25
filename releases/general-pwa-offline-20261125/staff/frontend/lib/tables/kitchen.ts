import {serverTimestamp} from 'firebase/firestore';
// Table preparation history is monotonic; rules prohibit returning a prepared task to PENDING.
export function tableKitchenProgress(item:any) {
 return item.tableSessionId?{tablePreparationStarted:true,tablePreparationStartedAt:item.tablePreparationStartedAt||serverTimestamp()}:{};
}
