import type { DataRow } from "./types";

const DEPTS = ["Sales", "Engineering", "Marketing", "Finance", "Operations", "Support"] as const;
const STATUSES = ["Active", "Active", "Active", "Active", "On Leave", "Inactive"] as const;
const REGIONS = ["East", "West", "Central", "North", "South"] as const;
const CITIES: Record<(typeof REGIONS)[number], string[]> = {
  East: ["Boston", "New York", "Philadelphia"],
  West: ["Seattle", "San Francisco", "Portland"],
  Central: ["Chicago", "Dallas", "Denver"],
  North: ["Minneapolis", "Detroit"],
  South: ["Austin", "Atlanta", "Miami"],
};
const ROLES: Record<(typeof DEPTS)[number], string[]> = {
  Sales: ["Account Exec", "SDR", "Sales Manager"],
  Engineering: ["Software Engineer", "Data Engineer", "Staff Engineer"],
  Marketing: ["Content Lead", "Growth Marketer", "Designer"],
  Finance: ["Analyst", "Controller", "FP&A"],
  Operations: ["Ops Coordinator", "Program Manager"],
  Support: ["Support Specialist", "Success Manager"],
};

function mulberry32(seed: number) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function gauss(rng: () => number, mu: number, sigma: number) {
  const u = 1 - rng();
  const v = 1 - rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function isoDate(start: Date, plusDays: number) {
  const d = new Date(start);
  d.setDate(d.getDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

export function buildSampleEmployees(n = 80, seed = 7): DataRow[] {
  const rng = mulberry32(seed);
  const start = new Date(2020, 0, 15);
  const rows: DataRow[] = [];
  for (let i = 1; i <= n; i += 1) {
    const dept = pick(rng, DEPTS);
    const region = pick(rng, REGIONS);
    const salary = Math.max(48000, Math.min(175000, Math.round(gauss(rng, 92000, 18000))));
    const perf = Math.round(Math.min(5, Math.max(1, gauss(rng, 3.6, 0.7))) * 10) / 10;
    rows.push({
      EmployeeID: `E${String(i).padStart(4, "0")}`,
      Name: `Person ${i}`,
      Age: 22 + Math.floor(rng() * 37),
      Department: dept,
      Role: pick(rng, ROLES[dept]),
      Status: pick(rng, STATUSES),
      Region: region,
      City: pick(rng, CITIES[region]),
      HireDate: isoDate(start, Math.floor(rng() * 2000)),
      Salary: salary,
      Performance: perf,
      Headcount: pick(rng, [0, 0, 0, 1, 1, 2, 3]),
    });
  }
  rows[0] = { ...rows[0], Salary: 480000 };
  rows[1] = { ...rows[1], Age: 82 };
  rows[2] = { ...rows[2], Status: "Contractor" };
  rows[3] = { ...rows[3], Performance: 0.2 };
  return rows;
}

export const SAMPLE_FILE_NAME = "employees.xlsx";
export const SAMPLE_BLURB =
  "80 employees across six departments, with a few planted anomalies (extreme salary, age 82, rare status Contractor).";
