import {useEffect,useLayoutEffect,useState} from 'react';
import {registerPosUpdateBoundary,blockAppUpdate,updatesAreSafe,UPDATE_SAFETY_EVENT,CRITICAL_OPERATION_EVENT} from './connectivity';
export function useUpdateBlocker(blocked:boolean){useLayoutEffect(()=>blocked?blockAppUpdate():undefined,[blocked])}
export function useUpdatesAreSafe(){const [safe,setSafe]=useState(updatesAreSafe);useEffect(()=>{const sync=()=>setSafe(updatesAreSafe());for(const e of [UPDATE_SAFETY_EVENT,CRITICAL_OPERATION_EVENT,'online','offline'])window.addEventListener(e,sync);sync();return()=>{for(const e of [UPDATE_SAFETY_EVENT,CRITICAL_OPERATION_EVENT,'online','offline'])window.removeEventListener(e,sync)}},[]);return safe}

export function usePosUpdateBoundary(){useLayoutEffect(()=>registerPosUpdateBoundary(),[])}
