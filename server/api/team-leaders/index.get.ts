import { listTeamLeaders } from '../../services/flow/team-leaders'

/** 班组和班组长（设置页"班组长"）：登录即可看；修改见 [teamId].put.ts */
export default defineFlowHandler(async () => listTeamLeaders())
