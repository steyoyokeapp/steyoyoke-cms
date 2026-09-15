// Calendar dates are strings, never local-time instants.
export function daysInMonth(year: number, month: number) {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31][month - 1] ?? 0;
}
export function calendarValue(year: number, month: number, day: number) {
  return `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
export function parseDisplayDate(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const [,d,m,y] = match, day=Number(d), month=Number(m), year=Number(y);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year,month) ? calendarValue(year,month,day) : null;
}
export function displayDate(value: string) {
  if (!value) return "";
  const [year,month,day]=value.split("-"); return `${day}/${month}/${year}`;
}
export function calendarUTC(year: number, month: number, day: number) {
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);return date;
}
