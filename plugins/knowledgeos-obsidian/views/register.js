function registerKnowledgeViews(plugin, viewTypes, constructors) {
  plugin.registerView(viewTypes.today, (leaf) => new constructors.TodayView(leaf, plugin));
  plugin.registerView(viewTypes.reviews, (leaf) => new constructors.ReviewCenterView(leaf, plugin));
  plugin.registerView(viewTypes.inbox, (leaf) => new constructors.InboxCenterView(leaf, plugin));
  plugin.registerView(viewTypes.system, (leaf) => new constructors.SystemCenterView(leaf, plugin));
}

module.exports = { registerKnowledgeViews };
