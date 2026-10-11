/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "work-imports-oversight",
      severity: "error",
      comment: "Lane A may not import Lane B.",
      from: { path: "^src/lanes/work/" },
      to: { path: "^src/lanes/oversight/" },
    },
    {
      name: "oversight-imports-work",
      severity: "error",
      comment: "Lane B may not import Lane A.",
      from: { path: "^src/lanes/oversight/" },
      to: { path: "^src/lanes/work/" },
    },
    {
      name: "lane-deep-core",
      severity: "error",
      comment: "Lanes may import only the public core entry, src/core/index.ts.",
      from: { path: "^src/lanes/" },
      to: { path: "^src/core/", pathNot: "^src/core/index\\.ts$" },
    },
    {
      name: "work-imports-private-modules",
      severity: "error",
      comment: "The work lane reaches the database and config only through @/core.",
      from: { path: "^src/lanes/work/" },
      to: { path: "^src/(db|config)/" },
    },
    {
      name: "oversight-imports-private-modules",
      severity: "error",
      comment: "The oversight lane reaches the database and config only through @/core.",
      from: { path: "^src/lanes/oversight/" },
      to: { path: "^src/(db|config)/" },
    },
    {
      name: "work-routes-import-oversight",
      severity: "error",
      comment: "Work routes stay on the work lane.",
      from: { path: "^src/app/\\(work\\)/" },
      to: { path: "^src/lanes/oversight/" },
    },
    {
      name: "oversight-routes-import-work",
      severity: "error",
      comment: "Oversight routes stay on the oversight lane.",
      from: { path: "^src/app/\\(oversight\\)/" },
      to: { path: "^src/lanes/work/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
