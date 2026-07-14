export async function up(mongoose: any) {
  await mongoose.connection.collection("connectors").createIndex({ tenantId: 1, updatedAt: -1 });
  await mongoose.connection.collection("connectors").createIndex({ tenantId: 1, "syncState.files.sourceId": 1 });
  await mongoose.connection.collection("documents").createIndex({ tenantId: 1, connector: 1, updatedAt: -1 });
}