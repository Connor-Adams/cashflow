/* eslint-disable react-refresh/only-export-components */
import { Icon, type IconName } from '@connor-adams/designsystem'
import { isCategoryIconName, type CategoryIconName } from '@cashflow/shared'
import { useCategories } from '../lib/useCategories'

export const CATEGORY_ICON_GLYPHS: Record<CategoryIconName, IconName> = {
  ShoppingCart: 'shopping-cart', ShoppingBag: 'shopping-bag', Utensils: 'utensils',
  Coffee: 'coffee', Pizza: 'pizza', Beer: 'beer', Wine: 'wine',
  Home: 'home', Bed: 'bed', Sofa: 'sofa', Lightbulb: 'lightbulb', Plug: 'plug',
  Wifi: 'wifi', Phone: 'phone', Smartphone: 'smartphone', Tv: 'tv', Laptop: 'laptop',
  Car: 'car', Fuel: 'fuel', Bus: 'bus', Train: 'train', Plane: 'plane',
  Bike: 'bike', ParkingSquare: 'parking-square',
  Stethoscope: 'stethoscope', Pill: 'pill', HeartPulse: 'heart-pulse', Dumbbell: 'dumbbell',
  GraduationCap: 'graduation-cap', BookOpen: 'book-open', Briefcase: 'briefcase',
  Building2: 'building-2',
  PiggyBank: 'piggy-bank', Landmark: 'landmark', CreditCard: 'credit-card',
  Banknote: 'banknote', Wallet: 'wallet', Receipt: 'receipt',
  Gift: 'gift', PartyPopper: 'party-popper', Cake: 'cake', Baby: 'baby',
  PawPrint: 'paw-print', Flower2: 'flower-2', Trees: 'trees',
  Wrench: 'wrench', Hammer: 'hammer', Paintbrush: 'paintbrush', Scissors: 'scissors',
  Shirt: 'shirt', Gem: 'gem',
  Camera: 'camera', Music: 'music', Film: 'film', Gamepad2: 'gamepad-2', Ticket: 'ticket',
  Map: 'map', Mountain: 'mountain', Sun: 'sun', Cloud: 'cloud', Umbrella: 'umbrella',
  Snowflake: 'snowflake', Flame: 'flame', Droplet: 'droplet',
  Trash2: 'trash', Recycle: 'recycle', Leaf: 'leaf', Heart: 'heart', Star: 'star',
  Sparkles: 'sparkles',
  Tag: 'tag', Bookmark: 'bookmark', Folder: 'folder', Box: 'box', Package: 'package',
  Truck: 'truck',
  HandCoins: 'hand-coins', TrendingUp: 'trending-up', TrendingDown: 'trending-down',
  Calculator: 'calculator', Percent: 'percent', Repeat: 'repeat',
  ArrowRightLeft: 'arrow-right-left', Globe: 'globe', Server: 'server',
  Flag: 'flag', Trophy: 'trophy', Gauge: 'gauge', Monitor: 'monitor',
  Tooth: 'tooth', Lipstick: 'lipstick', Vape: 'vape',
}

type Props = {
  name: string | null | undefined
  size?: number
  className?: string
}

export function CategoryIcon({ name, size = 16, className }: Props) {
  const { byName } = useCategories()
  if (!name) return null
  const cat = byName(name)
  const iconName = isCategoryIconName(cat?.icon) ? cat.icon : null
  return (
    <Icon
      name={iconName ? CATEGORY_ICON_GLYPHS[iconName] : 'tag'}
      size={size}
      className={className}
      data-icon={iconName ?? 'Tag'}
    />
  )
}
