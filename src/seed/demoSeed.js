import { ObjectId } from "mongodb";
import {
  APPROVAL_STATUS,
  SERVICE_CATEGORIES,
  SERVICE_COLLECTION,
  SERVICE_MODES,
  SERVICE_OWNER_FIELD,
} from "../services/serviceModel.js";
import {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_COLLECTION,
  BOOKING_STATUS,
  makeActiveBookingKey,
} from "../bookings/bookingModel.js";
import { USER_COLLECTION } from "../users/userModel.js";

export const SEED_TAG = "fixmate-demo-seed-v1";
export const SEED_SOURCE = "fixmate-demo-seed";
export const SAFE_DEMO_DB_NAME_PATTERN = /(demo|seed|test|local|dev)/i;

export const SEED_OBJECT_IDS = Object.freeze({
  services: Object.freeze({
    smartphoneScreen: "71eeed000000000000000001",
    smartphoneBattery: "71eeed000000000000000002",
    laptopSsd: "71eeed000000000000000003",
    laptopThermal: "71eeed000000000000000004",
    acService: "71eeed000000000000000005",
    acLeak: "71eeed000000000000000006",
    fridgeCooling: "71eeed000000000000000007",
    fridgeCompressor: "71eeed000000000000000008",
    tvDisplay: "71eeed000000000000000009",
    tvSound: "71eeed00000000000000000a",
    washerDrain: "71eeed00000000000000000b",
    electricalSafety: "71eeed00000000000000000c",
    smartphoneChargingPort: "71eeed00000000000000000d",
    smartphoneCamera: "71eeed00000000000000000e",
    laptopKeyboard: "71eeed00000000000000000f",
    laptopDisplay: "71eeed000000000000000010",
    acInstallation: "71eeed000000000000000011",
    acThermostat: "71eeed000000000000000012",
    fridgeDoorSeal: "71eeed000000000000000013",
    fridgeIcemaker: "71eeed000000000000000014",
    tvPowerBoard: "71eeed000000000000000015",
    tvMountSetup: "71eeed000000000000000016",
    washerVibration: "71eeed000000000000000017",
    washerInletValve: "71eeed000000000000000018",
    washerControlPanel: "71eeed000000000000000019",
    electricalFanInstall: "71eeed00000000000000001a",
    electricalBreaker: "71eeed00000000000000001b",
    electricalLighting: "71eeed00000000000000001c",
  }),
  bookings: Object.freeze({
    requested: "71eeed000000000000000101",
    accepted: "71eeed000000000000000102",
    inProgress: "71eeed000000000000000103",
    completed: "71eeed000000000000000104",
    cancelled: "71eeed000000000000000105",
    rejected: "71eeed000000000000000106",
  }),
});

function oid(hex) {
  return new ObjectId(hex);
}

function asObjectId(value, label) {
  if (value instanceof ObjectId) return value;
  if (typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value.trim())) {
    return new ObjectId(value.trim());
  }
  throw new Error(`${label} must be a 24-character hex ObjectId string.`);
}

function normalizeId(value) {
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === "string") return value.trim();
  return String(value);
}

export function assertSafeDatabaseName(databaseName) {
  if (typeof databaseName !== "string" || databaseName.trim() === "") {
    throw new Error("A target database name is required.");
  }
  const name = databaseName.trim();
  if (!SAFE_DEMO_DB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing to seed database "${name}" because it is not clearly identified as a demo/seed/test/local/dev database.`,
    );
  }
  return name;
}

export function assertSeedEnvironment({ nodeEnv = process.env.NODE_ENV, databaseName, confirmed } = {}) {
  if (String(nodeEnv || "").trim().toLowerCase() === "production") {
    throw new Error("Refusing to seed because NODE_ENV is production.");
  }
  const safeName = assertSafeDatabaseName(databaseName);
  if (confirmed !== true) {
    throw new Error("Seed confirmation is required before writing demo data.");
  }
  return { databaseName: safeName };
}

function normalizeTechnician(tech, index) {
  const id = asObjectId(tech?.id, `technicians[${index}].id`);
  const name = typeof tech?.name === "string" && tech.name.trim() ? tech.name.trim() : null;
  const email = typeof tech?.email === "string" && tech.email.trim() ? tech.email.trim().toLowerCase() : null;
  if (!name || !email) {
    throw new Error(`technicians[${index}] must include name and email.`);
  }
  return { id, name, email };
}

export function buildSeedServiceDocuments({ technicians, now = new Date("2026-11-22T00:00:00.000Z") } = {}) {
  if (!Array.isArray(technicians) || technicians.length < 2) {
    throw new Error("At least 2 technician users are required for seed services.");
  }
  const [techA, techB] = technicians.map(normalizeTechnician);

  // Technician slot mapping (owner-confirmed demo assignment):
  // - techA: Laptop & PC specialist slot (owner-reported Istiak in demo data). All Laptop & PC services use techA.
  // - techB: second demo technician slot (owner-reported Nayim in demo data).
  // Seed script receives IDs at runtime; it does not invent identities. Owner must supply correct technician IDs.
  const defs = [
    // Smartphone (4)
    { key: "smartphoneScreen", tech: techA, title: "Smartphone Screen Replacement", category: "Smartphone", description: "Cracked screen diagnosis, OEM-grade replacement, and touch calibration for common smartphone models.", image: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=1200&q=80", basePrice: 79, estimatedDuration: "1-2 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Mirpur" },
    { key: "smartphoneBattery", tech: techB, title: "Smartphone Battery Health Repair", category: "Smartphone", description: "Battery health check, safe replacement, charging-port inspection, and post-repair power test.", image: "https://images.unsplash.com/photo-1598327105666-5b89351aff97?auto=format&fit=crop&w=1200&q=80", basePrice: 49, estimatedDuration: "45-90 minutes", serviceMode: "Home Visit", serviceArea: "Dhaka - Dhanmondi" },
    { key: "smartphoneChargingPort", tech: techA, title: "Smartphone Charging Port Repair", category: "Smartphone", description: "Charging port cleaning, connector replacement when needed, and power delivery testing for reliable charging.", image: "https://images.unsplash.com/photo-1580910051074-3eb694886505?auto=format&fit=crop&w=1200&q=80", basePrice: 39, estimatedDuration: "45-60 minutes", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Mirpur" },
    { key: "smartphoneCamera", tech: techB, title: "Smartphone Camera Lens Service", category: "Smartphone", description: "Rear/front camera lens inspection, module cleaning or replacement, and focus/image quality verification.", image: "https://images.unsplash.com/photo-1512054502232-10a0a035d672?auto=format&fit=crop&w=1200&q=80", basePrice: 59, estimatedDuration: "1-2 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Dhanmondi" },

    // Laptop & PC (4) - all assigned to techA (Laptop & PC specialist / Istiak demo slot)
    { key: "laptopSsd", tech: techA, title: "Laptop SSD Upgrade & Data Migration", category: "Laptop & PC", description: "SSD compatibility check, installation, data migration, and boot performance verification for laptops and desktops.", image: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=1200&q=80", basePrice: 109, estimatedDuration: "2-3 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Uttara" },
    { key: "laptopThermal", tech: techA, title: "Laptop Thermal Cleaning Service", category: "Laptop & PC", description: "Internal dust cleaning, thermal paste refresh, fan inspection, and temperature stability check.", image: "https://images.unsplash.com/photo-1588702547919-26089e690ecc?auto=format&fit=crop&w=1200&q=80", basePrice: 59, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Banani" },
    { key: "laptopKeyboard", tech: techA, title: "Laptop Keyboard Replacement", category: "Laptop & PC", description: "Keyboard diagnosis, compatible replacement, and key response testing for laptop input issues.", image: "https://images.unsplash.com/photo-1525547719571-a2d4ac8945e2?auto=format&fit=crop&w=1200&q=80", basePrice: 69, estimatedDuration: "1-2 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Uttara" },
    { key: "laptopDisplay", tech: techA, title: "Laptop Display & Hinge Repair", category: "Laptop & PC", description: "Screen flicker diagnosis, hinge inspection, display cable check, and panel replacement planning where needed.", image: "https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=1200&q=80", basePrice: 129, estimatedDuration: "2-4 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Uttara" },

    // AC (4)
    { key: "acService", tech: techA, title: "AC Deep Cleaning & Performance Tune-Up", category: "AC", description: "Indoor unit cleaning, filter wash, drain line check, and cooling performance test for split AC units.", image: "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=1200&q=80", basePrice: 69, estimatedDuration: "2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Gulshan" },
    { key: "acLeak", tech: techB, title: "AC Refrigerant Leak Diagnosis", category: "AC", description: "Leak inspection, pressure testing, refrigerant assessment, and repair recommendation for cooling loss issues.", image: "https://images.unsplash.com/photo-1509391366360-2e959784a276?auto=format&fit=crop&w=1200&q=80", basePrice: 89, estimatedDuration: "2-4 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Mohammadpur" },
    { key: "acInstallation", tech: techB, title: "AC Installation & Mounting Check", category: "AC", description: "Split AC mounting inspection, basic installation setup, drainage alignment, and startup cooling verification.", image: "https://images.unsplash.com/photo-1631545806609-35d4d6c871b1?auto=format&fit=crop&w=1200&q=80", basePrice: 119, estimatedDuration: "3-4 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Gulshan" },
    { key: "acThermostat", tech: techA, title: "AC Thermostat & Sensor Repair", category: "AC", description: "Thermostat calibration, sensor inspection, and control response testing for inconsistent AC temperature behavior.", image: "https://images.unsplash.com/photo-1611095973362-88e8e2557e58?auto=format&fit=crop&w=1200&q=80", basePrice: 79, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Mohammadpur" },

    // Refrigerator (4)
    { key: "fridgeCooling", tech: techA, title: "Refrigerator Cooling Troubleshooting", category: "Refrigerator", description: "Cooling diagnosis, thermostat check, airflow inspection, and practical repair plan for refrigerator temperature issues.", image: "https://images.unsplash.com/photo-1584568694244-14fbdf83bd30?auto=format&fit=crop&w=1200&q=80", basePrice: 75, estimatedDuration: "1-3 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Badda" },
    { key: "fridgeCompressor", tech: techB, title: "Refrigerator Compressor Health Check", category: "Refrigerator", description: "Compressor and relay inspection, electrical safety check, and cooling recovery testing.", image: "https://images.unsplash.com/photo-1571175443880-49e1d25b2bc5?auto=format&fit=crop&w=1200&q=80", basePrice: 95, estimatedDuration: "2-3 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Khilgaon" },
    { key: "fridgeDoorSeal", tech: techA, title: "Refrigerator Door Seal Replacement", category: "Refrigerator", description: "Door gasket inspection, seal replacement, and temperature retention check to reduce cooling loss.", image: "https://images.unsplash.com/photo-1536353284924-9220c464e262?auto=format&fit=crop&w=1200&q=80", basePrice: 55, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Badda" },
    { key: "fridgeIcemaker", tech: techB, title: "Refrigerator Ice Maker Repair", category: "Refrigerator", description: "Ice maker water line inspection, component diagnosis, and operation test for ice production issues.", image: "https://images.unsplash.com/photo-1588854337115-1c67d9247e4d?auto=format&fit=crop&w=1200&q=80", basePrice: 85, estimatedDuration: "1-3 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Khilgaon" },

    // TV (4)
    { key: "tvDisplay", tech: techA, title: "TV Display & Backlight Diagnosis", category: "TV", description: "Screen flicker diagnosis, backlight inspection, and display panel assessment for LED/LCD televisions.", image: "https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?auto=format&fit=crop&w=1200&q=80", basePrice: 85, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Rampura" },
    { key: "tvSound", tech: techB, title: "TV Audio & Connectivity Repair", category: "TV", description: "Speaker output testing, HDMI/audio port inspection, and connectivity troubleshooting for smart TVs.", image: "https://images.unsplash.com/photo-1461151304267-38535e780c79?auto=format&fit=crop&w=1200&q=80", basePrice: 65, estimatedDuration: "1-2 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Motijheel" },
    { key: "tvPowerBoard", tech: techB, title: "TV Power Board Diagnosis", category: "TV", description: "Power supply inspection, startup fault diagnosis, and safe board-level troubleshooting for TVs that won't turn on.", image: "https://images.unsplash.com/photo-1567690187548-f07b1d7bf5a9?auto=format&fit=crop&w=1200&q=80", basePrice: 99, estimatedDuration: "2-3 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Rampura" },
    { key: "tvMountSetup", tech: techA, title: "TV Wall Mount & Setup Service", category: "TV", description: "Wall mount installation check, secure TV mounting, cable management, and basic input/setup verification.", image: "https://images.unsplash.com/photo-1522869635100-9f4c5e86aa37?auto=format&fit=crop&w=1200&q=80", basePrice: 70, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Motijheel" },

    // Washing Machine (4)
    { key: "washerDrain", tech: techA, title: "Washing Machine Drain & Pump Repair", category: "Washing Machine", description: "Drain blockage removal, pump inspection, hose check, and spin-cycle test for front and top load washers.", image: "https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?auto=format&fit=crop&w=1200&q=80", basePrice: 72, estimatedDuration: "1-3 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Malibagh" },
    { key: "washerVibration", tech: techB, title: "Washing Machine Vibration & Balance Fix", category: "Washing Machine", description: "Leveling check, drum balance inspection, shock absorber assessment, and test cycle for excessive vibration.", image: "https://images.unsplash.com/photo-1604335399105-a0c585fd81a1?auto=format&fit=crop&w=1200&q=80", basePrice: 68, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Malibagh" },
    { key: "washerInletValve", tech: techA, title: "Washing Machine Water Inlet Repair", category: "Washing Machine", description: "Inlet valve inspection, hose/filter cleaning, and water flow testing for filling or leakage issues.", image: "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?auto=format&fit=crop&w=1200&q=80", basePrice: 64, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Banasree" },
    { key: "washerControlPanel", tech: techB, title: "Washing Machine Control Panel Diagnosis", category: "Washing Machine", description: "Control panel and sensor diagnosis, error code check, and operational testing for cycle control problems.", image: "https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=1200&q=80", basePrice: 79, estimatedDuration: "1-3 hours", serviceMode: "Shop Drop-off", serviceArea: "Dhaka - Banasree" },

    // Electrical (4)
    { key: "electricalSafety", tech: techB, title: "Home Electrical Outlet Safety Inspection", category: "Electrical", description: "Outlet and switch inspection, basic wiring safety checks, and fault isolation for common household electrical issues.", image: "https://images.unsplash.com/photo-1621905252507-b35492cc74b4?auto=format&fit=crop&w=1200&q=80", basePrice: 55, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Tejgaon" },
    { key: "electricalFanInstall", tech: techA, title: "Ceiling Fan Installation & Wiring", category: "Electrical", description: "Ceiling fan mounting, wiring connection check, switch test, and safe operation verification.", image: "https://images.unsplash.com/photo-1616046229478-9901c5536a45?auto=format&fit=crop&w=1200&q=80", basePrice: 60, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Tejgaon" },
    { key: "electricalBreaker", tech: techB, title: "Circuit Breaker & Trip Diagnosis", category: "Electrical", description: "Breaker panel inspection, trip-cause diagnosis, load check, and safety recommendations for recurring electrical trips.", image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=1200&q=80", basePrice: 75, estimatedDuration: "1-3 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Mirpur" },
    { key: "electricalLighting", tech: techA, title: "Indoor Lighting Fixture Repair", category: "Electrical", description: "Light fixture inspection, switch/wiring diagnosis, fixture replacement support, and illumination testing.", image: "https://images.unsplash.com/photo-1565814329452-e1efa11c5b89?auto=format&fit=crop&w=1200&q=80", basePrice: 50, estimatedDuration: "1-2 hours", serviceMode: "Home Visit", serviceArea: "Dhaka - Dhanmondi" },
  ];

  return defs.map((def, index) => ({
    _id: oid(SEED_OBJECT_IDS.services[def.key]),
    title: def.title,
    category: def.category,
    description: def.description,
    image: def.image,
    basePrice: def.basePrice,
    estimatedDuration: def.estimatedDuration,
    serviceMode: def.serviceMode,
    serviceArea: def.serviceArea,
    [SERVICE_OWNER_FIELD]: def.tech.id,
    technicianName: def.tech.name,
    technicianEmail: def.tech.email,
    approvalStatus: APPROVAL_STATUS.APPROVED,
    isAvailable: true,
    createdAt: new Date(now.getTime() + index * 1000),
    seedTag: SEED_TAG,
    seedSource: SEED_SOURCE,
  }));
}

function normalizeCustomer(customer) {
  const id = asObjectId(customer?.id, "customer.id");
  const name = typeof customer?.name === "string" && customer.name.trim() ? customer.name.trim() : null;
  const email = typeof customer?.email === "string" && customer.email.trim() ? customer.email.trim().toLowerCase() : null;
  const phone = typeof customer?.phone === "string" && customer.phone.trim() ? customer.phone.trim() : "+8801700000000";
  if (!name || !email) throw new Error("customer must include name and email.");
  return { id, name, email, phone };
}

export function buildSeedBookingDocuments({ customer, services, now = new Date("2026-11-22T00:00:00.000Z") } = {}) {
  const cust = normalizeCustomer(customer);
  if (!Array.isArray(services) || services.length < 6) {
    throw new Error("At least 6 seeded services are required to build demo bookings.");
  }
  const byId = new Map(services.map((service) => [normalizeId(service._id), service]));
  const pick = (hexKey) => {
    const service = byId.get(SEED_OBJECT_IDS.services[hexKey]);
    if (!service) throw new Error(`Missing seeded service for booking: ${hexKey}`);
    return service;
  };

  const specs = [
    { key: "requested", serviceKey: "smartphoneScreen", status: BOOKING_STATUS.REQUESTED, paymentStatus: "unpaid", finalAmount: null, address: "House 12, Road 3, Mirpur, Dhaka", preferredDate: new Date("2026-12-01T10:00:00.000Z"), problemDescription: "Phone screen is cracked after a drop and touch input is inconsistent." },
    { key: "accepted", serviceKey: "acService", status: BOOKING_STATUS.ACCEPTED, paymentStatus: "unpaid", finalAmount: null, address: "Flat B2, Gulshan, Dhaka", preferredDate: new Date("2026-12-02T14:00:00.000Z"), problemDescription: "AC cooling is weak and the indoor unit needs a full maintenance check." },
    { key: "inProgress", serviceKey: "laptopThermal", status: BOOKING_STATUS.IN_PROGRESS, paymentStatus: "unpaid", finalAmount: null, address: "House 8, Banani, Dhaka", preferredDate: new Date("2026-12-03T11:00:00.000Z"), problemDescription: "Laptop overheats during normal use and the fan gets very loud." },
    { key: "completed", serviceKey: "washerDrain", status: BOOKING_STATUS.COMPLETED, paymentStatus: "unpaid", finalAmount: 72, address: "House 21, Malibagh, Dhaka", preferredDate: new Date("2026-11-25T09:00:00.000Z"), problemDescription: "Washing machine drains slowly and leaves water after the cycle." },
    { key: "cancelled", serviceKey: "tvSound", status: BOOKING_STATUS.CANCELLED, paymentStatus: "unpaid", finalAmount: null, address: "House 4, Motijheel, Dhaka", preferredDate: new Date("2026-12-04T15:00:00.000Z"), problemDescription: "TV audio cuts out intermittently when using HDMI input." },
    { key: "rejected", serviceKey: "electricalSafety", status: BOOKING_STATUS.REJECTED, paymentStatus: "unpaid", finalAmount: null, address: "House 15, Tejgaon, Dhaka", preferredDate: new Date("2026-12-05T13:00:00.000Z"), problemDescription: "A wall outlet sparks occasionally and needs a safety inspection." },
  ];

  return specs.map((spec, index) => {
    const service = pick(spec.serviceKey);
    const serviceId = service._id instanceof ObjectId ? service._id : oid(service._id);
    const technicianId = service[SERVICE_OWNER_FIELD] instanceof ObjectId ? service[SERVICE_OWNER_FIELD] : oid(service[SERVICE_OWNER_FIELD]);
    const doc = {
      _id: oid(SEED_OBJECT_IDS.bookings[spec.key]),
      serviceId,
      serviceTitle: service.title,
      serviceImage: service.image,
      serviceCategory: service.category,
      basePrice: service.basePrice,
      technicianId,
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      customerId: cust.id,
      customerName: cust.name,
      customerEmail: cust.email,
      customerPhone: cust.phone,
      address: spec.address,
      preferredDate: spec.preferredDate,
      problemDescription: spec.problemDescription,
      status: spec.status,
      finalAmount: spec.finalAmount,
      paymentStatus: spec.paymentStatus,
      createdAt: new Date(now.getTime() + (index + 20) * 1000),
      seedTag: SEED_TAG,
      seedSource: SEED_SOURCE,
    };
    if (ACTIVE_BOOKING_STATUSES.includes(spec.status)) {
      doc.activeBookingKey = makeActiveBookingKey(cust.id, serviceId);
    }
    return doc;
  });
}

export function validateSeedDocuments({ services, bookings } = {}) {
  const errors = [];
  if (!Array.isArray(services) || services.length < 28) errors.push("At least 28 services are required.");
  if (!Array.isArray(bookings) || bookings.length < 1) errors.push("At least 1 booking is required.");

  const categories = new Set();
  const categoryCounts = new Map();
  for (const service of services || []) {
    if (!service?._id) errors.push("Service missing _id.");
    if (!SERVICE_CATEGORIES.includes(service?.category)) errors.push(`Invalid service category: ${service?.category}`);
    if (!SERVICE_MODES.includes(service?.serviceMode)) errors.push(`Invalid service mode: ${service?.serviceMode}`);
    if (service?.approvalStatus !== APPROVAL_STATUS.APPROVED) errors.push(`Service not approved: ${service?.title}`);
    if (service?.isAvailable !== true) errors.push(`Service not available: ${service?.title}`);
    if (typeof service?.image !== "string" || !service.image.startsWith("https://")) errors.push(`Service image must be HTTPS: ${service?.title}`);
    if (typeof service?.basePrice !== "number" || !(service.basePrice > 0)) errors.push(`Invalid basePrice: ${service?.title}`);
    if (!service?.[SERVICE_OWNER_FIELD]) errors.push(`Missing technicianId: ${service?.title}`);
    if (service?.seedTag !== SEED_TAG) errors.push(`Missing seedTag: ${service?.title}`);
    categories.add(service?.category);
    if (typeof service?.category === "string") {
      categoryCounts.set(service.category, (categoryCounts.get(service.category) || 0) + 1);
    }
  }
  for (const category of SERVICE_CATEGORIES) {
    if (!categories.has(category)) errors.push(`Missing category coverage: ${category}`);
    const count = categoryCounts.get(category) || 0;
    if (count < 4) errors.push(`Category ${category} must have at least 4 services; found ${count}.`);
  }

  const serviceIds = new Set((services || []).map((s) => normalizeId(s._id)));
  const statuses = new Set();
  for (const booking of bookings || []) {
    if (!booking?._id) errors.push("Booking missing _id.");
    if (!serviceIds.has(normalizeId(booking?.serviceId))) errors.push(`Booking references unknown service: ${normalizeId(booking?._id)}`);
    if (!booking?.customerId || !booking?.technicianId) errors.push(`Booking missing user reference: ${normalizeId(booking?._id)}`);
    if (!BOOKING_STATUS || !Object.values(BOOKING_STATUS).includes(booking?.status)) errors.push(`Invalid booking status: ${booking?.status}`);
    if (booking?.seedTag !== SEED_TAG) errors.push(`Missing booking seedTag: ${normalizeId(booking?._id)}`);
    if (ACTIVE_BOOKING_STATUSES.includes(booking?.status) && !booking?.activeBookingKey) errors.push(`Active booking missing activeBookingKey: ${normalizeId(booking?._id)}`);
    if (!ACTIVE_BOOKING_STATUSES.includes(booking?.status) && booking?.activeBookingKey) errors.push(`Terminal booking should not have activeBookingKey: ${normalizeId(booking?._id)}`);
    if (booking?.status === BOOKING_STATUS.COMPLETED && !(booking?.finalAmount > 0)) errors.push(`Completed booking missing finalAmount: ${normalizeId(booking?._id)}`);
    statuses.add(booking?.status);
  }
  const requiredStatuses = [
    BOOKING_STATUS.REQUESTED,
    BOOKING_STATUS.ACCEPTED,
    BOOKING_STATUS.REJECTED,
    BOOKING_STATUS.IN_PROGRESS,
    BOOKING_STATUS.COMPLETED,
  ];
  for (const status of requiredStatuses) {
    if (!statuses.has(status)) errors.push(`Missing booking status coverage: ${status}`);
  }

  return { ok: errors.length === 0, errors, categories: [...categories], statuses: [...statuses], categoryCounts: Object.fromEntries(categoryCounts) };
}

function idFilter(id) {
  const normalized = normalizeId(id);
  if (/^[a-fA-F0-9]{24}$/.test(normalized)) {
    return { $in: [normalized, new ObjectId(normalized)] };
  }
  return { $in: [normalized] };
}

async function findUserById(usersCollection, id) {
  return usersCollection.findOne({ _id: idFilter(id) }, { projection: { _id: 1, name: 1, email: 1, role: 1 } });
}

export async function resolveSeedUsers({ usersCollection, technicianIds, customerId }) {
  if (!usersCollection || typeof usersCollection.findOne !== "function") {
    throw new Error("A users collection with findOne is required.");
  }
  if (!Array.isArray(technicianIds) || technicianIds.length < 2) {
    throw new Error("At least 2 technician IDs are required.");
  }
  if (!customerId) throw new Error("A customer ID is required.");

  const technicians = [];
  for (const [index, id] of technicianIds.entries()) {
    const user = await findUserById(usersCollection, id);
    if (!user) throw new Error(`Technician user not found for technicians[${index}].`);
    if (user.role !== "technician") throw new Error(`User ${normalizeId(user._id)} must have technician role.`);
    technicians.push({ id: user._id, name: user.name, email: user.email, role: user.role });
  }

  const customerUser = await findUserById(usersCollection, customerId);
  if (!customerUser) throw new Error("Customer user not found.");
  if (customerUser.role !== "customer") throw new Error(`User ${normalizeId(customerUser._id)} must have customer role.`);
  const customer = { id: customerUser._id, name: customerUser.name, email: customerUser.email, role: customerUser.role };

  return { technicians, customer };
}

async function upsertSeedDocument(collection, doc, { apply }) {
  const existing = await collection.findOne({ _id: doc._id }, { projection: { _id: 1, seedTag: 1 } });
  if (existing && existing.seedTag !== SEED_TAG) {
    throw new Error(`Refusing to overwrite non-seed document with _id ${normalizeId(doc._id)}.`);
  }

  if (!apply) {
    return { action: existing ? "would-update" : "would-insert", id: normalizeId(doc._id) };
  }

  const result = await collection.updateOne(
    { _id: doc._id },
    { $set: doc },
    { upsert: true },
  );
  const action = result.upsertedCount > 0 ? "inserted" : "updated";
  return { action, id: normalizeId(doc._id) };
}

export async function seedDemoData({
  db,
  technicianIds,
  customerId,
  apply = false,
  now = new Date(),
  logger = console,
} = {}) {
  if (!db || typeof db.collection !== "function") {
    throw new Error("A MongoDB database handle is required.");
  }

  const usersCollection = db.collection(USER_COLLECTION);
  const servicesCollection = db.collection(SERVICE_COLLECTION);
  const bookingsCollection = db.collection(BOOKING_COLLECTION);

  const { technicians, customer } = await resolveSeedUsers({ usersCollection, technicianIds, customerId });
  const services = buildSeedServiceDocuments({ technicians, now });
  const bookings = buildSeedBookingDocuments({ customer, services, now });
  const validation = validateSeedDocuments({ services, bookings });
  if (!validation.ok) {
    throw new Error(`Seed validation failed: ${validation.errors.join("; ")}`);
  }

  const summary = {
    apply,
    databaseName: typeof db.databaseName === "string" ? db.databaseName : undefined,
    technicians: technicians.map((t) => ({ id: normalizeId(t.id), role: t.role })),
    customer: { id: normalizeId(customer.id), role: customer.role },
    services: { total: services.length, categories: validation.categories, actions: [] },
    bookings: { total: bookings.length, statuses: validation.statuses, actions: [] },
  };

  for (const service of services) {
    summary.services.actions.push(await upsertSeedDocument(servicesCollection, service, { apply }));
  }
  for (const booking of bookings) {
    summary.bookings.actions.push(await upsertSeedDocument(bookingsCollection, booking, { apply }));
  }

  const countActions = (actions) => actions.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] || 0) + 1;
    return acc;
  }, {});
  summary.services.counts = countActions(summary.services.actions);
  summary.bookings.counts = countActions(summary.bookings.actions);

  logger.info?.(`[seed-demo] ${apply ? "apply" : "dry-run"} complete`, {
    databaseName: summary.databaseName,
    services: summary.services.counts,
    bookings: summary.bookings.counts,
  });

  return summary;
}

export function getSeedSummary() {
  return {
    seedTag: SEED_TAG,
    serviceCount: Object.keys(SEED_OBJECT_IDS.services).length,
    bookingCount: Object.keys(SEED_OBJECT_IDS.bookings).length,
    categories: [...SERVICE_CATEGORIES],
    bookingStatuses: [
      BOOKING_STATUS.REQUESTED,
      BOOKING_STATUS.ACCEPTED,
      BOOKING_STATUS.IN_PROGRESS,
      BOOKING_STATUS.COMPLETED,
      BOOKING_STATUS.CANCELLED,
      BOOKING_STATUS.REJECTED,
    ],
  };
}
