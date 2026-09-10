import { connectDb } from "@/lib/db";
import { MockOnshapeDrawing, MockOnshapePart, MockPropertyDef } from "@/lib/models";

/**
 * Property ids are fixed 24-hex strings so they look like the real thing and
 * stay stable across reseeds (the enterprise propertyMap caches them).
 */
export const MOCK_PROPS = {
  name:        { propertyId: "57f3fb8efa3416c06701d60d", name: "Name", valueType: "STRING", builtIn: true },
  partNumber:  { propertyId: "57f3fb8efa3416c06701d60e", name: "Part number", valueType: "STRING", builtIn: true },
  revision:    { propertyId: "57f3fb8efa3416c06701d60f", name: "Revision", valueType: "STRING", builtIn: true },
  description: { propertyId: "57f3fb8efa3416c06701d610", name: "Description", valueType: "STRING", builtIn: true },
  material:    { propertyId: "57f3fb8efa3416c06701d611", name: "Material", valueType: "STRING", builtIn: true },
  state:       { propertyId: "57f3fb8efa3416c06701d612", name: "State", valueType: "ENUM", builtIn: true },
  vendor:      { propertyId: "57f3fb8efa3416c06701d613", name: "Vendor", valueType: "STRING", builtIn: false },
  project:     { propertyId: "57f3fb8efa3416c06701d614", name: "Project", valueType: "STRING", builtIn: false },
};

/**
 * Drawing tabs, so the release flow has sheets to capture.
 *
 * Each names the parts it draws. Onshape does not expose that relationship
 * outside a release package, and the mock supplies it the same way Onshape
 * effectively does — by adding the drawing to the package alongside the parts.
 */
const SEED_DRAWINGS = [
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e8a2b3c4d5e6f70819202131", elementName: "Housing Drawing",
    partIds: ["JHD", "JHE"],
  },
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e8a2b3c4d5e6f70819202132", elementName: "Output Shaft Drawing",
    partIds: ["KTF"],
  },
  {
    documentId: "d3a2b3c4d5e6f70819202125", documentName: "Chassis Frame",
    elementId: "e8a2b3c4d5e6f70819202133", elementName: "Frame Rail Drawing",
    partIds: ["MQZ", "MRA"],
  },
];

const P = MOCK_PROPS;

const SEED_PARTS = [
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e1a2b3c4d5e6f70819202123", elementName: "Housing Part Studio",
    partId: "JHD", props: {
      [P.name.propertyId]: "Gearbox Housing",
      [P.partNumber.propertyId]: "GB-1001",
      [P.description.propertyId]: "Cast aluminium main housing, 6 bolt flange",
      // Onshape returns material as an object, not a string — mirrored here so the
      // display path is exercised the way a real tenant exercises it.
      [P.material.propertyId]: { id: "6061", libraryName: "Onshape Material Library", displayName: "Aluminium 6061-T6" },
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "Precision Castings Ltd",
      [P.project.propertyId]: "Falcon",
    },
  },
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e1a2b3c4d5e6f70819202123", elementName: "Housing Part Studio",
    partId: "JHE", props: {
      [P.name.propertyId]: "Housing Cover",
      [P.partNumber.propertyId]: "GB-1002",
      [P.description.propertyId]: "Stamped cover plate with gasket groove",
      [P.material.propertyId]: "Steel 1018",
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "",
      [P.project.propertyId]: "Falcon",
    },
  },
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e2a2b3c4d5e6f70819202124", elementName: "Shaft Part Studio",
    partId: "KTF", props: {
      [P.name.propertyId]: "Output Shaft",
      [P.partNumber.propertyId]: "GB-2001",
      [P.description.propertyId]: "Splined output shaft, hardened and ground",
      [P.material.propertyId]: "4340 Alloy Steel",
      [P.state.propertyId]: 2,
      [P.vendor.propertyId]: "Turned Parts Co",
      [P.project.propertyId]: "Falcon",
    },
  },
  {
    documentId: "d3a2b3c4d5e6f70819202125", documentName: "Chassis Frame",
    elementId: "e3a2b3c4d5e6f70819202126", elementName: "Frame Part Studio",
    partId: "MQZ", props: {
      [P.name.propertyId]: "Lower Frame Rail",
      [P.partNumber.propertyId]: "CH-3001",
      [P.description.propertyId]: "Welded box section rail, 1200mm",
      [P.material.propertyId]: "Steel S355",
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "",
      [P.project.propertyId]: "Kestrel",
    },
  },
  {
    documentId: "d3a2b3c4d5e6f70819202125", documentName: "Chassis Frame",
    elementId: "e3a2b3c4d5e6f70819202126", elementName: "Frame Part Studio",
    partId: "MRA", props: {
      [P.name.propertyId]: "Cross Member",
      [P.partNumber.propertyId]: "CH-3002",
      [P.description.propertyId]: "Bolt-in cross member with jacking points",
      [P.material.propertyId]: "Steel S355",
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "",
      [P.project.propertyId]: "Kestrel",
    },
  },
];

/**
 * Idempotent: upserts definitions, parts and drawings without clobbering
 * anything since edited in the simulator.
 *
 * Revision is deliberately absent from the seeded properties. In PLM, Onshape
 * owns the revision and assigns it at release — a mock tenant whose parts
 * arrived already at revision A would hide the whole pre-release lifecycle,
 * which is the thing worth demonstrating.
 */
export async function seedMockOnshape(
  companyId: string
): Promise<{ properties: number; parts: number; drawings: number }> {
  await connectDb();

  const defs = Object.values(MOCK_PROPS);
  for (const d of defs) {
    await MockPropertyDef.updateOne(
      { companyId, propertyId: d.propertyId },
      {
        $set: {
          companyId,
          propertyId: d.propertyId,
          name: d.name,
          valueType: d.valueType,
          builtIn: d.builtIn,
          enumValues: d.valueType === "ENUM"
            ? ["In Progress", "Pending", "Released", "Obsolete"]
            : [],
        },
      },
      { upsert: true }
    );
  }

  for (const p of SEED_PARTS) {
    await MockOnshapePart.updateOne(
      { companyId, documentId: p.documentId, elementId: p.elementId, partId: p.partId, configuration: "default" },
      {
        $set: {
          companyId, documentId: p.documentId, documentName: p.documentName,
          workspaceId: "w1a2b3c4d5e6f70819202199",
          elementId: p.elementId, elementName: p.elementName,
          partId: p.partId, configuration: "default",
          elementType: "PARTSTUDIO",
        },
        $setOnInsert: { properties: p.props },
      },
      { upsert: true }
    );
  }

  for (const d of SEED_DRAWINGS) {
    await MockOnshapeDrawing.updateOne(
      { companyId, documentId: d.documentId, elementId: d.elementId },
      {
        $set: {
          companyId, documentId: d.documentId, documentName: d.documentName,
          workspaceId: "w1a2b3c4d5e6f70819202199",
          elementId: d.elementId, elementName: d.elementName,
          partIds: d.partIds,
        },
      },
      { upsert: true }
    );
  }

  return { properties: defs.length, parts: SEED_PARTS.length, drawings: SEED_DRAWINGS.length };
}
