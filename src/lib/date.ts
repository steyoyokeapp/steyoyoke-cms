const cmsDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatCmsDate(value: Date | string) {
  return cmsDateFormatter.format(typeof value === "string" ? new Date(value) : value);
}
