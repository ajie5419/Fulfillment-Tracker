import { aggregatePanorama, type PanoramaData } from '../../../shared/panorama'
import { getBoard } from './board'

export async function getPanorama(visibleWorkOrders: string[] | undefined, now = new Date()): Promise<PanoramaData> {
  const board = await getBoard(visibleWorkOrders, now, { withClosed: true })
  return aggregatePanorama(board.rows)
}
