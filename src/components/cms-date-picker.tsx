"use client";
import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { calendarUTC, calendarValue, daysInMonth, displayDate, parseDisplayDate } from "@/lib/calendar-date";
import "./cms-date-picker.css";
const months=["January","February","March","April","May","June","July","August","September","October","November","December"];
const invalidMessage="Enter a valid date in DD/MM/YYYY format.";
export function CmsDatePicker({label,value,onChange,disabled=false}: {label:string;value:string;onChange:(value:string)=>void;disabled?:boolean}) {
  const id=useId(), input=useRef<HTMLInputElement>(null), dialog=useRef<HTMLDialogElement>(null);
  const [text,setText]=useState(()=>displayDate(value)), [error,setError]=useState("");
  const [view,setView]=useState({year:2026,month:1,day:1}), [today,setToday]=useState("");
  function positionCalendar(){
    if(!dialog.current?.open||!input.current)return;
    const rect=input.current.getBoundingClientRect(), calendar=dialog.current.getBoundingClientRect();
    dialog.current.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-calendar.width-12))}px`;
    const top=rect.bottom+8+calendar.height<=window.innerHeight-12 ? rect.bottom+8 : rect.top-calendar.height-8;
    dialog.current.style.top=`${Math.max(12,Math.min(top,window.innerHeight-calendar.height-12))}px`;
  }
  useLayoutEffect(positionCalendar,[view]);
  useEffect(()=>{window.addEventListener('resize',positionCalendar);return()=>window.removeEventListener('resize',positionCalendar);},[]);
  function close(){dialog.current?.close();input.current?.focus();}
  function open(){
    if(disabled||!input.current||!dialog.current)return;
    const now=new Date(), current=parseDisplayDate(text)||value||calendarValue(now.getFullYear(),now.getMonth()+1,now.getDate());
    const [year,month,day]=current.split('-').map(Number);setView({year:year!,month:month!,day:day!});setToday(calendarValue(now.getFullYear(),now.getMonth()+1,now.getDate()));
    dialog.current.showModal();
    requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus());
  }
  function select(day:number){const next=calendarValue(view.year,view.month,day);setText(displayDate(next));setError("");input.current?.setCustomValidity("");onChange(next);close();}
  function moveMonth(delta:number){const date=calendarUTC(view.year,view.month+delta,1);const year=date.getUTCFullYear();if(year<1||year>9999)return;setView({year,month:date.getUTCMonth()+1,day:1});}
  function navigate(event:KeyboardEvent<HTMLButtonElement>,day:number){
    const offsets:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
    let next:Date|undefined;
    if(event.key in offsets)next=calendarUTC(view.year,view.month,day+offsets[event.key]!);
    else if(event.key==='Home'||event.key==='End'){const weekday=(calendarUTC(view.year,view.month,day).getUTCDay()+6)%7;next=calendarUTC(view.year,view.month,day+(event.key==='Home'?-weekday:6-weekday));}
    else if(event.key==='PageUp'||event.key==='PageDown'){const month=view.month+(event.key==='PageUp'?-1:1);const first=calendarUTC(view.year,month,1);next=calendarUTC(first.getUTCFullYear(),first.getUTCMonth()+1,Math.min(day,daysInMonth(first.getUTCFullYear(),first.getUTCMonth()+1)));}
    if(!next)return;event.preventDefault();const year=next.getUTCFullYear();if(year<1||year>9999)return;const target=next.getUTCDate();setView({year,month:next.getUTCMonth()+1,day:target});requestAnimationFrame(()=>dialog.current?.querySelector<HTMLButtonElement>(`[data-day="${target}"]`)?.focus());
  }
  const offset=(calendarUTC(view.year,view.month,1).getUTCDay()+6)%7;
  return <div className="cms-date-field"><label htmlFor={id}>{label}</label><div className="cms-date-control">
    <input ref={input} id={id} type="text" inputMode="numeric" placeholder="DD/MM/YYYY" maxLength={10} autoComplete="off" value={text} readOnly={disabled} aria-invalid={!!error} aria-describedby={error?`${id}-error`:undefined} aria-haspopup="dialog" onClick={open} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();open();}}} onChange={e=>{const next=e.target.value;setText(next);const parsed=parseDisplayDate(next);const message=next&&!parsed?invalidMessage:"";e.target.setCustomValidity(message);setError("");if(!message)onChange(parsed??"");}} onBlur={()=>{if(text&&!parseDisplayDate(text))setError(invalidMessage);}} onInvalid={()=>setError(invalidMessage)} />
    <button type="button" className="cms-calendar-toggle" aria-label={`Open ${label} calendar`} disabled={disabled} onClick={open}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/></svg></button>
    </div>{error&&<p id={`${id}-error`} className="cms-date-error" role="alert">{error}</p>}
    <dialog ref={dialog} className="cms-calendar" aria-label={`${label} calendar`} onChange={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Enter"&&e.target instanceof HTMLInputElement){e.preventDefault();dialog.current?.querySelector<HTMLButtonElement>("[data-day]")?.focus();}}} onClose={()=>input.current?.focus()} onClick={e=>{if(e.target===e.currentTarget)close();}}>
      <div className="cms-calendar-nav"><button type="button" aria-label="Previous month" onClick={()=>moveMonth(-1)}>‹</button><span aria-live="polite">{months[view.month-1]} {view.year}</span><button type="button" aria-label="Next month" onClick={()=>moveMonth(1)}>›</button></div>
      <div className="cms-calendar-period"><label>Month<select aria-label="Calendar month" value={view.month} onChange={e=>setView({...view,month:Number(e.target.value),day:1})}>{months.map((m,i)=><option key={m} value={i+1}>{m}</option>)}</select></label><label>Year<input aria-label="Calendar year" type="number" min={1} max={9999} value={view.year} onChange={e=>{const year=Number(e.target.value);if(Number.isInteger(year)&&year>=1&&year<=9999)setView({...view,year,day:1});}} /></label></div>
      <div className="cms-calendar-week" aria-hidden="true">{['Mo','Tu','We','Th','Fr','Sa','Su'].map(d=><span key={d}>{d}</span>)}</div>
      <div className="cms-calendar-days" role="group" aria-label="Choose day">{Array.from({length:offset},(_,i)=><span key={`blank-${i}`}/>)}{Array.from({length:daysInMonth(view.year,view.month)},(_,i)=>{const day=i+1,canonical=calendarValue(view.year,view.month,day);return <button key={day} type="button" data-day={day} tabIndex={day===Math.min(view.day,daysInMonth(view.year,view.month))?0:-1} aria-label={`${day} ${months[view.month-1]} ${view.year}`} aria-pressed={canonical===value} aria-current={canonical===today?'date':undefined} onKeyDown={e=>navigate(e,day)} onClick={()=>select(day)}>{day}</button>;})}</div>
      <div className="cms-calendar-footer"><button type="button" onClick={()=>{setText("");setError("");input.current?.setCustomValidity("");onChange("");close();}}>Clear date</button><button type="button" onClick={close}>Close</button></div>
    </dialog>
  </div>;
}
