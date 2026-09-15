import {describe,it,expect} from 'vitest';
import {parseDisplayDate,displayDate,calendarUTC,calendarValue} from '@/lib/calendar-date';
describe('calendar dates',()=>{
 it.each(['15/09/2026','29/02/2024','29/02/2000','01/01/0001','31/12/9999'])('round trips %s without local time',value=>{expect(displayDate(parseDisplayDate(value)!)).toBe(value);});
 it.each(['31/02/2026','29/02/2026','29/02/1900','00/01/2026','01/13/2026','1/2/2026','2026-09-15','01/01/0000'])('rejects %s',value=>expect(parseDisplayDate(value)).toBeNull());
 it('uses Monday-first UTC calendar arithmetic across month/year boundaries',()=>{expect(calendarUTC(2026,9,1).getUTCDay()).toBe(2);expect(calendarUTC(2026,1,0).toISOString().slice(0,10)).toBe('2025-12-31');expect(calendarValue(1,1,1)).toBe('0001-01-01');});
});
