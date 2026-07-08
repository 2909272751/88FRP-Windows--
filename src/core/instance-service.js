class InstanceService {
  constructor({ store }) {
    this.store = store;
  }

  async list() {
    return this.store.listInstances();
  }

  async get(instanceId) {
    const instance = await this.store.getInstance(instanceId);
    if (!instance) {
      throw new Error("实例不存在。");
    }
    return instance;
  }

  async create(payload) {
    if (!String(payload.name || "").trim()) {
      throw new Error("实例名称不能为空。");
    }
    return this.store.createInstance(payload);
  }

  async update(instanceId, payload) {
    const nextValue = { ...payload };
    if (Object.prototype.hasOwnProperty.call(nextValue, "name") && !String(nextValue.name || "").trim()) {
      throw new Error("实例名称不能为空。");
    }

    const instance = await this.store.updateInstance(instanceId, nextValue);
    if (!instance) {
      throw new Error("实例不存在。");
    }
    return instance;
  }

  async delete(instanceId) {
    const deleted = await this.store.deleteInstance(instanceId);
    if (!deleted) {
      throw new Error("实例不存在。");
    }
    return { success: true };
  }
}

module.exports = {
  InstanceService,
};
